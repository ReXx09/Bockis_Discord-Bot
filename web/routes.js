/**
 * web/routes.js — Express-Routen für Dashboard & API
 *
 * Wird über eine Factory-Funktion initialisiert, damit bot.js seine
 * Abhängigkeiten (config, client, logger, …) sauber in die Routen injizieren
 * kann — ohne globale Variablen oder Circular Requires.
 *
 * Aufruf in bot.js:
 *   const registerRoutes = require('./web/routes');
 *   registerRoutes(app, { config, logger, client, sequelize, prom,
 *                          getMonitorData, updateStatusMessage, rootDir: __dirname });
 */

'use strict';

const path        = require('path');
const fs          = require('fs');
const os          = require('os');
const express     = require('express');
const axios       = require('axios');
const { execFile, execSync, spawn } = require('child_process');

// Erlaubte Werte für Service-Control (Whitelist gegen Command-Injection)
const ALLOWED_SERVICES = ['bockis-bot', 'uptime-kuma', 'cloudflared'];
const ALLOWED_ACTIONS  = ['start', 'stop', 'restart', 'status'];

// ── Factory-Funktion ──────────────────────────────────────────────────────────
module.exports = function startWebServer({
  config,
  logger,
  client,
  sequelize,
  prom,
  getMonitorData,
  updateStatusMessage,
  rootDir           // = __dirname aus bot.js (Projektwurzel)
}) {
  // ── Express-App erstellen ───────────────────────────────────────────────────
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(rootDir, 'views'));  // absoluter Pfad, CWD-unabhängig
  app.use(express.json());
  app.use(express.static(path.join(rootDir, 'public')));

  // ── Middleware ──────────────────────────────────────────────────────────────

  /** Nur localhost darf zugreifen (für /health und /metrics) */
  function localOnly(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    return res.status(403).json({ error: 'Forbidden' });
  }

  /** Optionaler HTTP-Basic-Auth-Schutz für das Dashboard */
  function dashboardAuth(req, res, next) {
    const password = process.env.DASHBOARD_PASSWORD;
    if (!password) return next();
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [, pwd] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (pwd && pwd === password) return next();
    res.set('WWW-Authenticate', 'Basic realm="Service Dashboard"');
    return res.status(401).send('Authentifizierung erforderlich');
  }

  function readCpuTempC() {
    try {
      const tempFile = '/sys/class/thermal/thermal_zone0/temp';
      if (fs.existsSync(tempFile)) {
        const raw = fs.readFileSync(tempFile, 'utf8').trim();
        const milli = parseInt(raw, 10);
        if (Number.isFinite(milli)) return milli / 1000;
      }
    } catch { /* ignore */ }

    try {
      const out = execSync('vcgencmd measure_temp', { timeout: 1200 }).toString();
      const match = out.match(/temp=([0-9.]+)/i);
      if (match) return parseFloat(match[1]);
    } catch { /* ignore */ }

    return null;
  }

  function getPublicStatusUrl() {
    const cloudflareUrl = config.get('cloudflare.publicUrl');
    const slug = config.get('uptimeKuma.statusPageSlug');
    if (cloudflareUrl) return `${cloudflareUrl.replace(/\/+$/, '')}/status/${slug}`;

    const base = config.get('uptimeKuma.url');
    if (!base) return null;
    return `${base.replace(/\/+$/, '')}/status/${slug}`;
  }

  function readMetaTag(html, attrName, attrValue) {
    const esc = String(attrValue).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<meta[^>]*${attrName}=["']${esc}["'][^>]*content=["']([^"']*)["'][^>]*>`, 'i');
    const altRegex = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*${attrName}=["']${esc}["'][^>]*>`, 'i');
    const match = html.match(regex) || html.match(altRegex);
    return match?.[1]?.trim() || null;
  }

  async function runLinkProbe(url, userAgent) {
    try {
      const resp = await axios.get(url, {
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: () => true,
        responseType: 'text',
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });

      const html = typeof resp.data === 'string' ? resp.data : '';
      const headers = resp.headers || {};
      const status = resp.status;
      const contentType = String(headers['content-type'] || '');
      const finalUrl = resp.request?.res?.responseUrl || url;

      const ogTitle = readMetaTag(html, 'property', 'og:title');
      const ogDescription = readMetaTag(html, 'property', 'og:description');
      const ogImage = readMetaTag(html, 'property', 'og:image');
      const ogUrl = readMetaTag(html, 'property', 'og:url');
      const twitterCard = readMetaTag(html, 'name', 'twitter:card');
      const twitterImage = readMetaTag(html, 'name', 'twitter:image');
      const metaDescription = readMetaTag(html, 'name', 'description');

      // Discord braucht für RichPreview: Titel + (Beschreibung ODER Bild)
      const hasDescription = ogDescription || metaDescription;
      const hasImage = ogImage || twitterImage;
      const richPreview = Boolean(ogTitle && (hasDescription || hasImage));
      const challengeDetected = /cf-challenge|attention required|captcha|cloudflare/i.test(html);

      return {
        ok: true,
        status,
        finalUrl,
        contentType,
        headers: {
          cacheControl: headers['cache-control'] || null,
          cfCacheStatus: headers['cf-cache-status'] || null,
          server: headers.server || null,
        },
        meta: {
          ogTitle,
          ogDescription,
          ogImage,
          ogUrl,
          twitterCard,
          twitterImage,
          metaDescription,
        },
        richPreview,
        challengeDetected,
      };
    } catch (err) {
      return {
        ok: false,
        error: err.message,
      };
    }
  }

  // ── Statische Routen ────────────────────────────────────────────────────────

  app.get('/', (req, res) => res.redirect('/dashboard'));

  app.get('/dashboard', dashboardAuth, (req, res) => {
    res.render('dashboard');
  });

  // ── Health-Check (nur localhost) ────────────────────────────────────────────

  app.get('/health', localOnly, async (req, res) => {
    let dbStatus = 'OK';
    try { await sequelize.authenticate(); } catch { dbStatus = 'ERROR'; }
    res.json({
      status: 'OK',
      uptime: process.uptime(),
      checks: {
        database: dbStatus,
        discord:  client.isReady() ? 'OK' : 'OFFLINE'
      }
    });
  });

  // ── Prometheus-Metriken (nur localhost) ─────────────────────────────────────

  app.get('/metrics', localOnly, async (req, res) => {
    try {
      const metrics = await prom.register.metrics();
      res.set('Content-Type', prom.register.contentType);
      res.end(metrics);
    } catch { res.status(500).end(); }
  });

  // ── API: Monitor-Status ─────────────────────────────────────────────────────

  app.get('/api/status', dashboardAuth, async (req, res) => {
    try {
      const monitors = await getMonitorData();
      res.json({ ok: true, monitors: monitors ?? [] });
    } catch (err) {
      logger.error(`/api/status Fehler: ${err.message}`);
      res.json({ ok: false, error: err.message, monitors: [] });
    }
  });

  // ── API: Bot-Info ───────────────────────────────────────────────────────────

  app.get('/api/bot-info', dashboardAuth, (req, res) => {
    const mem = process.memoryUsage();
    res.json({
      ok:           true,
      tag:          client.isReady() ? client.user.tag : 'Offline',
      ping:         client.isReady() ? client.ws.ping : -1,
      uptime:       process.uptime(),
      nodeVersion:  process.version,
      memUsedMb:    (mem.rss      / 1024 / 1024).toFixed(1),
      memHeapMb:    (mem.heapUsed / 1024 / 1024).toFixed(1),
      discordReady: client.isReady()
    });
  });

  // ── API: Raspberry/System-Info ─────────────────────────────────────────────

  app.get('/api/raspi-status', dashboardAuth, (req, res) => {
    try {
      const total = os.totalmem();
      const free = os.freemem();
      const used = Math.max(0, total - free);
      const usedPct = total > 0 ? (used / total) * 100 : 0;
      const load = os.loadavg();
      const cpuTemp = readCpuTempC();

      res.json({
        ok: true,
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()}`,
        uptime: os.uptime(),
        memTotalMb: Math.round(total / 1024 / 1024),
        memUsedMb: Math.round(used / 1024 / 1024),
        memFreeMb: Math.round(free / 1024 / 1024),
        memUsedPercent: Number(usedPct.toFixed(1)),
        load1: Number(load[0].toFixed(2)),
        load5: Number(load[1].toFixed(2)),
        load15: Number(load[2].toFixed(2)),
        cpuTempC: cpuTemp != null ? Number(cpuTemp.toFixed(1)) : null
      });
    } catch (err) {
      logger.error(`/api/raspi-status Fehler: ${err.message}`);
      res.json({ ok: false, error: err.message });
    }
  });

  // ── API: Log-Datei (letzte 100 Zeilen) ─────────────────────────────────────

  app.get('/api/logs', dashboardAuth, (req, res) => {
    try {
      const logDir = path.join(rootDir, 'logs');
      if (!fs.existsSync(logDir)) return res.json({ ok: true, lines: [], file: null });
      const files = fs.readdirSync(logDir)
        .filter(f => f.endsWith('.log'))
        .sort()
        .reverse();
      if (!files.length) return res.json({ ok: true, lines: [], file: null });
      const latest  = path.join(logDir, files[0]);
      const content = fs.readFileSync(latest, 'utf8');
      const lines   = content.split('\n').filter(Boolean).slice(-100).reverse();
      res.json({ ok: true, lines, file: files[0] });
    } catch (err) {
      logger.error(`/api/logs Fehler: ${err.message}`);
      res.json({ ok: false, error: err.message, lines: [], file: null });
    }
  });

  // ── API: Diagnose Link-Preview / Discord-Unfurl ───────────────────────────

  app.get('/api/diagnostics/link-preview', dashboardAuth, async (req, res) => {
    try {
      const targetUrl = getPublicStatusUrl();
      if (!targetUrl) {
        return res.json({
          ok: false,
          error: 'Keine öffentliche Status-URL konfiguriert (CLOUDFLARE_PUBLIC_URL / UPTIME_KUMA_URL)',
          targetUrl: null,
        });
      }

      const discordProbe = await runLinkProbe(
        targetUrl,
        'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discord.com)'
      );
      const defaultProbe = await runLinkProbe(
        targetUrl,
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'
      );

      const hints = [];
      if (!/^https:\/\//i.test(targetUrl)) {
        hints.push('Link-Preview benötigt in Discord in der Regel HTTPS.');
      }

      if (!discordProbe.ok) {
        hints.push(`Discord-Probe fehlgeschlagen: ${discordProbe.error}`);
      } else {
        if (!(discordProbe.status >= 200 && discordProbe.status < 400)) {
          hints.push(`Discord-Probe liefert HTTP ${discordProbe.status} statt 2xx/3xx.`);
        }
        if (!/text\/html/i.test(discordProbe.contentType || '')) {
          hints.push(`Content-Type ist nicht text/html (${discordProbe.contentType || 'unbekannt'}).`);
        }
        
        // Detaillierte Meta-Tag-Analyse
        if (!discordProbe.richPreview) {
          const ogTitle = discordProbe.meta?.ogTitle;
          const hasDesc = discordProbe.meta?.ogDescription || discordProbe.meta?.metaDescription;
          const hasImage = discordProbe.meta?.ogImage || discordProbe.meta?.twitterImage;
          
          if (ogTitle && !hasDesc && !hasImage) {
            hints.push('⚠️ OG:Title vorhanden, aber OG:Description + OG:Image FEHLEN → Discord zeigt keine Rich Preview.');
          } else if (!ogTitle) {
            hints.push('❌ OG:Title FEHLT → Keine Rich Preview möglich.');
          } else {
            hints.push('⚠️ Unzureichend Meta-Tags für Discord Rich Preview (Beschreibung oder Bild erforderlich).');
          }
        }
        
        if (discordProbe.challengeDetected) {
          hints.push('Cloudflare/Challenge erkannt - Discord-Crawler kann blockiert sein.');
        }
      }

      if (defaultProbe.ok && discordProbe.ok && defaultProbe.status !== discordProbe.status) {
        hints.push(`Unterschiedliche HTTP-Statuscodes (Browser=${defaultProbe.status}, Discord=${discordProbe.status}) deuten auf Crawler-Filter hin.`);
      }

      return res.json({
        ok: true,
        targetUrl,
        checkedAt: new Date().toISOString(),
        probes: {
          discord: discordProbe,
          browser: defaultProbe,
        },
        hints,
      });
    } catch (err) {
      logger.error(`/api/diagnostics/link-preview Fehler: ${err.message}`);
      return res.json({ ok: false, error: err.message });
    }
  });

  // ── API: Discord-Refresh ────────────────────────────────────────────────────

  app.post('/api/refresh', dashboardAuth, async (req, res) => {
    try {
      await updateStatusMessage();
      res.json({ ok: true, message: 'Status-Nachricht aktualisiert' });
    } catch (err) {
      logger.error(`/api/refresh Fehler: ${err.message}`);
      res.json({ ok: false, error: err.message });
    }
  });

  // ── API: Status-Unfurl-Proxy (Liefert Status-Seite mit injiziertem OG:Tags) ─

  app.get('/api/status-unfurl', async (req, res) => {
    try {
      const statusUrl = getPublicStatusUrl();
      if (!statusUrl) {
        return res.status(400).json({ ok: false, error: 'Status URL nicht konfiguriert' });
      }

      const monitors = await getMonitorData();
      const total = Array.isArray(monitors) ? monitors.length : 0;
      const up = Array.isArray(monitors)
        ? monitors.filter((m) => m && m.status === 1).length
        : 0;
      const down = Math.max(0, total - up);
      const summary = total > 0
        ? `${up}/${total} Dienste online${down > 0 ? ` · ${down} offline` : ''}`
        : 'Keine Monitor-Daten verfügbar';

      // Lade Status-Seite
      const resp = await axios.get(statusUrl, {
        timeout: 5000,
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }
      });

      let html = String(resp.data || '');
      const uptimeKumaUrl = config.get('uptimeKuma.url') || '';
      const cloudflareUrl = config.get('cloudflare.publicUrl') || '';
      const baseUrl = cloudflareUrl || uptimeKumaUrl;

      // Injiziere OG-Tags ins <head>
      const head = `
        <meta property="og:title" content="Dienste-Status">
        <meta property="og:description" content="${summary}">
        <meta property="og:image" content="${baseUrl}/api/badge/summary?style=flat-square">
        <meta property="og:url" content="${statusUrl}">
        <meta property="og:type" content="website">
        <meta name="twitter:card" content="summary_large_image">
        <meta name="twitter:title" content="Dienste-Status">
        <meta name="twitter:description" content="${summary}">
        <meta name="twitter:image" content="${baseUrl}/api/badge/summary?style=flat-square">
      `;

      html = html.replace('</head>', `${head}</head>`);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      logger.error(`/api/status-unfurl Fehler: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── API: Status-Badge (Umleitung zu Uptime Kuma Badge API) ──────────────────

  app.get('/api/status-badge/:monitorId', async (req, res) => {
    try {
      const { monitorId } = req.params;
      const baseUrl = (config.get('uptimeKuma.url') || '').replace(/\/+$/, '');
      if (!baseUrl) {
        return res.status(400).json({ ok: false, error: 'Uptime Kuma URL nicht konfiguriert' });
      }

      // Leite zur Uptime Kuma Badge API weiter
      const badgeUrl = `${baseUrl}/api/badge/${monitorId}/uptime?style=flat-square`;
      const resp = await axios.get(badgeUrl, { timeout: 5000, responseType: 'stream' });
      res.setHeader('Content-Type', resp.headers['content-type']);
      res.setHeader('Cache-Control', 'max-age=300'); // 5 Minuten Cache
      resp.data.pipe(res);
    } catch (err) {
      logger.error(`/api/status-badge Fehler: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── API: Grafische Summary-Badges generieren ────────────────────────────────

  app.get('/api/badge/summary', async (req, res) => {
    try {
      const { style = 'flat-square' } = req.query;
      const monitorData = getMonitorData ? getMonitorData() : {};
      const total = Object.keys(monitorData).length || 0;
      const up = Object.values(monitorData).filter((m) => m.status === 'up').length || 0;
      const down = total - up;

      // Einfache SVG Badge generieren (für Link-Preview Image)
      const badgeText = `${up}/${total} Online`;
      const bgColor = down === 0 ? '31C16E' : down === total ? 'E74C3C' : 'F39C12'; // Grün/Rot/Orange
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="160" height="28" role="img" aria-label="Status">
          <title>Status: ${badgeText}</title>
          <linearGradient id="s" x2="0" y2="100%">
            <stop offset="0" stop-color="#bbb"/>
            <stop offset="1" stop-color="#999"/>
          </linearGradient>
          <clipPath id="r">
            <rect width="160" height="28" rx="4" fill="#fff"/>
          </clipPath>
          <g clip-path="url(#r)">
            <rect width="107" height="28" fill="#555"/>
            <rect x="107" width="53" height="28" fill="#${bgColor}"/>
            <rect width="160" height="28" fill="url(#s)"/>
          </g>
          <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="100%">
            <text x="545" y="175" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="970">
              Status
            </text>
            <text x="545" y="165" transform="scale(.1)" textLength="970">
              Status
            </text>
            <text x="1325" y="175" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="430">
              ${badgeText}
            </text>
            <text x="1325" y="165" transform="scale(.1)" textLength="430">
              ${badgeText}
            </text>
          </g>
        </svg>
      `;

      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'max-age=300');
      res.send(svg);
    } catch (err) {
      logger.error(`/api/badge/summary Fehler: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── API: Service-Control (start / stop / restart via systemctl) ─────────────

  app.post('/api/service-control', dashboardAuth, (req, res) => {
    const { service, action } = req.body || {};

    if (!ALLOWED_SERVICES.includes(service))
      return res.status(400).json({ ok: false, error: 'Unerlaubter Service-Name' });
    if (!ALLOWED_ACTIONS.includes(action))
      return res.status(400).json({ ok: false, error: 'Unerlaubte Aktion' });

    logger.info(`Service-Control: ${action} ${service}`);
    execFile('sudo', ['systemctl', action, service], { timeout: 15_000 }, (err, stdout, stderr) => {
      const output = (stdout + stderr).trim();
      if (err && action !== 'status') {
        logger.warn(`Service-Control Fehler (${action} ${service}): ${err.message}`);
        return res.json({ ok: false, error: output || err.message });
      }
      res.json({ ok: true, output });
    });
  });

  app.get('/api/service-status', dashboardAuth, (req, res) => {
    const results = {};
    let pending = ALLOWED_SERVICES.length;
    ALLOWED_SERVICES.forEach(svc => {
      execFile('systemctl', ['is-active', svc], { timeout: 4000 }, (err, stdout) => {
        results[svc] = (stdout || '').trim();
        if (--pending === 0) res.json({ ok: true, services: results });
      });
    });
  });

  // ── API: Update-Check ───────────────────────────────────────────────────────

  app.get('/api/update-check', dashboardAuth, (req, res) => {
    try {
      try { execSync('git rev-parse --is-inside-work-tree', { cwd: rootDir, stdio: 'ignore' }); }
      catch { return res.json({ ok: true, hasGit: false, updateAvailable: false }); }

      try { execSync('git fetch origin main --quiet', { cwd: rootDir, timeout: 8000, stdio: 'ignore' }); }
      catch { return res.json({ ok: true, hasGit: true, fetchFailed: true, updateAvailable: false }); }

      const behind = parseInt(execSync('git rev-list HEAD..origin/main --count', { cwd: rootDir }).toString().trim(), 10) || 0;
      const ahead  = parseInt(execSync('git rev-list origin/main..HEAD --count', { cwd: rootDir }).toString().trim(), 10) || 0;
      const local  = execSync('git rev-parse --short HEAD',        { cwd: rootDir }).toString().trim();
      const remote = execSync('git rev-parse --short origin/main', { cwd: rootDir }).toString().trim();

      let commits = [];
      if (behind > 0) {
        commits = execSync(
          'git log HEAD..origin/main --oneline --format=%h|||%s|||%cr',
          { cwd: rootDir }
        ).toString().trim().split('\n').filter(Boolean).slice(0, 10)
          .map(l => { const [hash, subject, when] = l.split('|||'); return { hash, subject, when }; });
      }

      res.json({ ok: true, hasGit: true, fetchFailed: false, updateAvailable: behind > 0,
                 behind, ahead, local, remote, commits });
    } catch (err) {
      logger.error(`/api/update-check Fehler: ${err.message}`);
      res.json({ ok: false, error: err.message });
    }
  });

  // ── API: Update ausführen (Server-Sent Events) ──────────────────────────────

  app.post('/api/update-run', dashboardAuth, (req, res) => {
    const ALLOWED_MODES = ['auto', 'native', 'docker'];
    const mode       = ALLOWED_MODES.includes(req.body?.mode) ? req.body.mode : 'auto';
    const scriptPath = path.join(rootDir, 'update.sh');

    if (!fs.existsSync(scriptPath))
      return res.json({ ok: false, error: 'update.sh nicht gefunden' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const proc = spawn('bash', [scriptPath, '--bot-dir', rootDir, '--mode', mode, '--yes'],
      { cwd: rootDir });
    const send = (line) => res.write(`data: ${line.replace(/\n/g, ' ')}\n\n`);
    proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(send));
    proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(send));
    proc.on('close', code => { res.write(`data: __EXIT__:${code}\n\n`); res.end(); });
  });

  // ── API: Konfiguration lesen (Token maskiert) ───────────────────────────────

  app.get('/api/config', dashboardAuth, (req, res) => {
    const envPath = path.join(rootDir, '.env');
    if (!fs.existsSync(envPath)) return res.json({ ok: false, error: '.env nicht gefunden' });
    try {
      const raw = fs.readFileSync(envPath, 'utf8');
      const get = (key) => {
        const m = raw.match(new RegExp(`^${key}=(.*)$`, 'm'));
        return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
      };
      const token  = get('DISCORD_TOKEN');
      const masked = token.length > 12
        ? `${token.slice(0, 6)}${'*'.repeat(token.length - 12)}${token.slice(-6)}`
        : token ? '***' : '';
      res.json({
        ok: true,
        DISCORD_TOKEN:                masked,
        STATUS_CHANNEL_ID:            get('STATUS_CHANNEL_ID'),
        DISCORD_NOTIFICATION_CHANNEL: get('DISCORD_NOTIFICATION_CHANNEL'),
        DISCORD_STATUS_RENDER_MODE:   get('DISCORD_STATUS_RENDER_MODE') || 'auto',
        UPTIME_KUMA_URL:              get('UPTIME_KUMA_URL'),
        WEB_PUBLIC_URL:               get('WEB_PUBLIC_URL'),
        CHANNEL_STATUS_INDICATOR:     get('CHANNEL_STATUS_INDICATOR') || 'true',
      });
    } catch (err) {
      logger.error(`/api/config GET Fehler: ${err.message}`);
      res.json({ ok: false, error: err.message });
    }
  });

  // ── API: Konfiguration schreiben + Bot neu starten ──────────────────────────

  app.post('/api/config', dashboardAuth, (req, res) => {
    const ALLOWED_CFG = ['DISCORD_TOKEN', 'STATUS_CHANNEL_ID', 'DISCORD_NOTIFICATION_CHANNEL',
                         'DISCORD_STATUS_RENDER_MODE',
               'UPTIME_KUMA_URL', 'WEB_PUBLIC_URL', 'CHANNEL_STATUS_INDICATOR'];
    const envPath = path.join(rootDir, '.env');
    if (!fs.existsSync(envPath)) return res.json({ ok: false, error: '.env nicht gefunden' });

    const updates = {};
    for (const key of ALLOWED_CFG) {
      const raw = req.body?.[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const val = String(raw).trim();
      if (key === 'DISCORD_TOKEN') {
        if (val.includes('*')) continue;
        if (/[\n\r]/.test(val)) return res.json({ ok: false, error: 'Ungültiger Token (enthält Zeilenumbruch)' });
      }
      if ((key === 'STATUS_CHANNEL_ID' || key === 'DISCORD_NOTIFICATION_CHANNEL') && !/^\d+$/.test(val))
        return res.json({ ok: false, error: `${key}: Nur Zahlen erlaubt (Discord ID)` });
      if (key === 'DISCORD_STATUS_RENDER_MODE' && !['auto', 'direct', 'graphical', 'link_preview', 'embed'].includes(val))
        return res.json({ ok: false, error: 'DISCORD_STATUS_RENDER_MODE muss auto, direct, graphical, link_preview oder embed sein' });
      if (key === 'UPTIME_KUMA_URL' && !/^https?:\/\/.+/.test(val))
        return res.json({ ok: false, error: 'UPTIME_KUMA_URL muss mit http:// oder https:// beginnen' });
      if (key === 'WEB_PUBLIC_URL' && !/^https?:\/\/.+/.test(val))
        return res.json({ ok: false, error: 'WEB_PUBLIC_URL muss mit http:// oder https:// beginnen' });
      if (key === 'CHANNEL_STATUS_INDICATOR' && !['true', 'false'].includes(val))
        return res.json({ ok: false, error: 'CHANNEL_STATUS_INDICATOR muss true oder false sein' });
      updates[key] = val;
    }

    if (Object.keys(updates).length === 0)
      return res.json({ ok: false, error: 'Keine Änderungen übermittelt' });

    try {
      let envContent = fs.readFileSync(envPath, 'utf8');
      for (const [key, val] of Object.entries(updates)) {
        if (new RegExp(`^${key}=`, 'm').test(envContent)) {
          envContent = envContent.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${val}`);
        } else {
          envContent = envContent.trimEnd() + `\n${key}=${val}\n`;
        }
      }
      fs.writeFileSync(envPath, envContent, 'utf8');
      logger.info(`Konfiguration aktualisiert: ${Object.keys(updates).join(', ')}`);
    } catch (err) {
      logger.error(`/api/config POST Schreibfehler: ${err.message}`);
      return res.json({ ok: false, error: `Fehler beim Schreiben: ${err.message}` });
    }

    // Wichtig: erst Antwort senden, dann asynchron restarten.
    // Sonst wird der HTTP-Request beim Selbst-Neustart oft abgebrochen ("Failed to fetch").
    const updatedKeys = Object.keys(updates);

    const attemptRestart = (useSudo = true) => {
      const cmd = useSudo ? 'sudo' : 'systemctl';
      const args = useSudo ? ['-n', 'systemctl', 'restart', 'bockis-bot'] : ['restart', 'bockis-bot'];

      execFile(cmd, args, { timeout: 12000 }, (e) => {
        if (!e) {
          logger.info(`Service 'bockis-bot' erfolgreich neu gestartet (${useSudo ? 'mit sudo -n' : 'ohne sudo'})`);
          return;
        }

        if (useSudo) {
          logger.warn(`Restart via sudo -n fehlgeschlagen, fallback auf systemctl direkt: ${e.message}`);
          attemptRestart(false);
          return;
        }

        logger.error(`Service Restart endgültig fehlgeschlagen: ${e.message}`);
      });
    };

    res.once('finish', () => {
      setTimeout(() => attemptRestart(true), 150);
    });

    return res.json({
      ok: true,
      updated: updatedKeys,
      restarted: true,
      restartNote: 'Neustart wird im Hintergrund ausgelöst',
    });
  });

  // ── API: Cloudflare Tunnel Status ───────────────────────────────────────────

  app.get('/api/tunnel-status', dashboardAuth, (req, res) => {
    const publicUrl = config.get('cloudflare.publicUrl') || null;
    execFile('systemctl', ['is-active', 'cloudflared'], { timeout: 4000 }, (err, stdout) => {
      const active = (stdout || '').trim() === 'active';
      execFile('cloudflared', ['--version'], { timeout: 4000 }, (e2, ver) => {
        const installed = !e2;
        const version   = installed ? (ver || '').trim().split('\n')[0] : null;
        execFile('cloudflared', ['tunnel', 'list'], { timeout: 6000 }, (e3, tunnelOut) => {
          const tunnels = [];
          if (!e3 && tunnelOut) {
            const lines = tunnelOut.trim().split('\n').slice(1);
            for (const line of lines) {
              const parts = line.trim().split(/\s{2,}/);
              if (parts.length >= 2) tunnels.push({ id: parts[0], name: parts[1] });
            }
          }
          // Zero-Trust-Token-Tunnel: läuft als Service, aber kein lokaler CLI-Tunnel
          const zeroTrust = installed && active && tunnels.length === 0 && !!publicUrl;
          res.json({ installed, active, version, tunnels, publicUrl, zeroTrust });
        });
      });
    });
  });

  // ── HTTP-Server starten ─────────────────────────────────────────────────────
  const port   = config.get('webPort');
  const ifaces = os.networkInterfaces();
  let localIp  = 'localhost';
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) { localIp = iface.address; break; }
    }
    if (localIp !== 'localhost') break;
  }
  const server = app.listen(port, '0.0.0.0', () => {
    logger.info(`Dashboard verfügbar unter http://${localIp}:${port}/dashboard`);
    logger.info(`(Auch erreichbar als http://localhost:${port}/dashboard)`);
  });
  return server;
};
