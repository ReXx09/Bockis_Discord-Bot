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
const { ChannelType } = require('discord.js');
const { execFile, execFileSync, execSync, spawn } = require('child_process');

// Erlaubte Werte für Service-Control (Whitelist gegen Command-Injection)
const ALLOWED_SERVICES = ['bockis-bot', 'uptime-kuma', 'cloudflared'];
const ALLOWED_ACTIONS  = ['start', 'stop', 'restart', 'status'];

function execFilePromise(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

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

      // Discord braucht für echten Rich Preview: Title + (Description ODER Image)
      // Blog-Standard: og:title + og:description + og:image
      const hasMinimalOg = !!(ogTitle && (ogDescription || ogImage));
      const hasTwitter = !!(twitterCard && twitterImage);
      const richPreview = hasMinimalOg || hasTwitter;
      
      const challengeDetected = /cf-challenge|attention required|captcha|cloudflare/i.test(html);
      const isCloudflareServer = /cloudflare/i.test(String(headers.server || ''));

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
        hasMinimalOg,
        hasTwitter,
        challengeDetected,
        isCloudflareServer,
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

  // ── API: Zeitkontext (System vs Node-Prozess) ─────────────────────────────

  app.get('/api/time-context', dashboardAuth, (req, res) => {
    try {
      let systemTimezone = '';
      try {
        systemTimezone = execFileSync('timedatectl', ['show', '-p', 'Timezone', '--value'], { timeout: 2500 })
          .toString().trim();
      } catch { /* ignore */ }

      const now = new Date();
      const processTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || 'unknown';
      const processTime = now.toLocaleString('de-DE', { hour12: false });

      let systemTime = processTime;
      if (systemTimezone) {
        try {
          systemTime = new Intl.DateTimeFormat('de-DE', {
            timeZone: systemTimezone,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
          }).format(now);
        } catch { /* ignore */ }
      }

      const timezoneMismatch = Boolean(systemTimezone && processTimezone && systemTimezone !== processTimezone);

      return res.json({
        ok: true,
        systemTimezone,
        processTimezone,
        systemTime,
        processTime,
        timezoneMismatch,
      });
    } catch (err) {
      logger.error(`/api/time-context Fehler: ${err.message}`);
      return res.json({ ok: false, error: err.message });
    }
  });

  // ── API: Lokalisierung (Zeitzone / Datum-Uhrzeit / Sprache/Locale) ───────

  app.get('/api/system-localization', dashboardAuth, (req, res) => {
    let timezone = '';
    let systemLocale = '';

    const timezoneOptions = [
      { value: 'Europe/Berlin', label: 'Europe/Berlin (Deutschland)' },
      { value: 'Europe/Vienna', label: 'Europe/Vienna (Österreich)' },
      { value: 'Europe/Zurich', label: 'Europe/Zurich (Schweiz)' },
      { value: 'Europe/London', label: 'Europe/London (UK)' },
      { value: 'Europe/Paris', label: 'Europe/Paris (Frankreich)' },
      { value: 'Europe/Madrid', label: 'Europe/Madrid (Spanien)' },
      { value: 'Europe/Rome', label: 'Europe/Rome (Italien)' },
      { value: 'Europe/Warsaw', label: 'Europe/Warsaw (Polen)' },
      { value: 'UTC', label: 'UTC' },
      { value: 'America/New_York', label: 'America/New_York (US East)' },
      { value: 'America/Chicago', label: 'America/Chicago (US Central)' },
      { value: 'America/Denver', label: 'America/Denver (US Mountain)' },
      { value: 'America/Los_Angeles', label: 'America/Los_Angeles (US West)' },
      { value: 'Asia/Dubai', label: 'Asia/Dubai' },
      { value: 'Asia/Kolkata', label: 'Asia/Kolkata (India)' },
      { value: 'Asia/Bangkok', label: 'Asia/Bangkok' },
      { value: 'Asia/Singapore', label: 'Asia/Singapore' },
      { value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
      { value: 'Australia/Sydney', label: 'Australia/Sydney' }
    ];

    const localeOptions = [
      { value: 'de_DE.UTF-8', label: 'Deutsch (Deutschland)' },
      { value: 'en_GB.UTF-8', label: 'English (UK)' },
      { value: 'en_US.UTF-8', label: 'English (US)' },
      { value: 'fr_FR.UTF-8', label: 'Français (France)' },
      { value: 'es_ES.UTF-8', label: 'Español (España)' },
      { value: 'it_IT.UTF-8', label: 'Italiano (Italia)' },
      { value: 'nl_NL.UTF-8', label: 'Nederlands (Nederland)' },
      { value: 'pl_PL.UTF-8', label: 'Polski (Polska)' },
      { value: 'pt_PT.UTF-8', label: 'Português (Portugal)' },
      { value: 'tr_TR.UTF-8', label: 'Türkçe (Türkiye)' },
      { value: 'ru_RU.UTF-8', label: 'Русский (Россия)' }
    ];

    try {
      timezone = execFileSync('timedatectl', ['show', '-p', 'Timezone', '--value'], { timeout: 2500 })
        .toString().trim();
    } catch { /* ignore */ }

    try {
      const localectlOut = execFileSync('localectl', ['status'], { timeout: 2500 }).toString();
      const m = localectlOut.match(/^\s*System Locale:\s*(.+)$/mi);
      if (m?.[1]) {
        const langMatch = m[1].match(/(?:^|\s)LANG=([^\s]+)/i);
        if (langMatch?.[1]) systemLocale = langMatch[1].trim();
      }
    } catch { /* ignore */ }

    // Fallback für Raspberry Pi Setups ohne localectl
    if (!systemLocale) {
      try {
        const localeFile = '/etc/default/locale';
        if (fs.existsSync(localeFile)) {
          const raw = fs.readFileSync(localeFile, 'utf8');
          const m = raw.match(/^LANG=(.*)$/m);
          systemLocale = (m?.[1] || '').trim().replace(/^['"]|['"]$/g, '');
        }
      } catch { /* ignore */ }
    }

    if (!systemLocale && process.env.LANG) {
      systemLocale = process.env.LANG;
    }

    const now = new Date();
    const localDate = now.toLocaleDateString('de-DE');
    const localTime = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dateTimeLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    return res.json({
      ok: true,
      timezone,
      timezoneOptions,
      systemLocale,
      localeOptions,
      localDate,
      localTime,
      dateTimeLocal,
    });
  });

  app.post('/api/system-localization', dashboardAuth, async (req, res) => {
    const timezone = String(req.body?.timezone || '').trim();
    const datetimeLocal = String(req.body?.datetimeLocal || '').trim();
    const systemLocale = String(req.body?.systemLocale || '').trim();

    if (!timezone && !datetimeLocal && !systemLocale) {
      return res.status(400).json({ ok: false, error: 'Keine Änderungen übergeben' });
    }

    if (timezone && !/^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)+$/.test(timezone)) {
      return res.status(400).json({ ok: false, error: 'Ungültige Zeitzone (z. B. Europe/Berlin)' });
    }

    if (datetimeLocal && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(datetimeLocal)) {
      return res.status(400).json({ ok: false, error: 'Ungültiges Datum/Uhrzeit-Format' });
    }

    if (systemLocale && !/^[A-Za-z]{2}_[A-Za-z]{2}\.UTF-8$/.test(systemLocale)) {
      return res.status(400).json({ ok: false, error: 'Ungültige Sprache/Locale (z. B. de_DE.UTF-8)' });
    }

    const applied = [];
    let ntpWasEnabled = false;

    try {
      if (timezone) {
        await execFilePromise('sudo', ['timedatectl', 'set-timezone', timezone], { timeout: 10_000 });
        applied.push(`Zeitzone=${timezone}`);
      }

      if (datetimeLocal) {
        const dateForTimedatectl = datetimeLocal.replace('T', ' ') + ':00';

        try {
          const ntpRaw = execFileSync('timedatectl', ['show', '-p', 'NTP', '--value'], { timeout: 2500 })
            .toString().trim().toLowerCase();
          ntpWasEnabled = (ntpRaw === 'yes' || ntpRaw === 'true' || ntpRaw === '1');
        } catch { /* ignore */ }

        if (ntpWasEnabled) {
          await execFilePromise('sudo', ['timedatectl', 'set-ntp', 'false'], { timeout: 10_000 });
        }

        await execFilePromise('sudo', ['timedatectl', 'set-time', dateForTimedatectl], { timeout: 10_000 });
        applied.push(`Datum/Uhrzeit=${datetimeLocal}`);

        if (ntpWasEnabled) {
          await execFilePromise('sudo', ['timedatectl', 'set-ntp', 'true'], { timeout: 10_000 });
          applied.push('NTP wieder aktiviert');
        }
      }

      if (systemLocale) {
        try {
          await execFilePromise('sudo', ['localectl', 'set-locale', `LANG=${systemLocale}`], { timeout: 10_000 });
        } catch (err) {
          // Fallback für Systeme ohne localectl/localed
          await execFilePromise('sudo', ['update-locale', `LANG=${systemLocale}`], { timeout: 10_000 });
        }
        applied.push(`Sprache=${systemLocale}`);
      }

      logger.info(`/api/system-localization gesetzt: ${applied.join(', ')}`);
      return res.json({ ok: true, applied });
    } catch (err) {
      if (ntpWasEnabled) {
        try { await execFilePromise('sudo', ['timedatectl', 'set-ntp', 'true'], { timeout: 10_000 }); } catch { /* ignore */ }
      }
      const details = `${err.stderr || ''}${err.stdout || ''}${err.message || ''}`;
      logger.error(`/api/system-localization Fehler: ${details}`);
      const hint = /automatic time synchronization is enabled/i.test(String(details))
        ? 'Tipp: NTP war aktiv. Der Server versucht NTP automatisch zu pausieren; prüfe sudo-Rechte für timedatectl set-ntp.'
        : '';
      return res.status(500).json({ ok: false, error: 'Systemeinstellung konnte nicht gesetzt werden', details: String(details).trim(), hint });
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
      const currentRenderMode = config.get('discord.statusRenderMode');
      const modeUsesLinkPreview = ['auto', 'direct', 'graphical', 'link_preview'].includes(String(currentRenderMode || '').toLowerCase());
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

      const meta = discordProbe?.meta || {};
      const hasOgTitle = !!meta.ogTitle;
      const hasDescription = !!(meta.ogDescription || meta.metaDescription);
      const hasImage = !!(meta.ogImage || meta.twitterImage);
      const hasTwitterCard = !!meta.twitterCard;
      const richPreviewLikely = !!(hasOgTitle && (hasDescription || hasImage || hasTwitterCard));

      const hints = [];
      if (!modeUsesLinkPreview) {
        hints.push(`ℹ️ Render-Modus "${currentRenderMode}" nutzt keine OG-Link-Preview als Pflicht. Discord-/Meta-Checks sind hier nur informativ.`);
      }
      if (!/^https:\/\//i.test(targetUrl)) {
        hints.push('🔴 Link-Preview benötigt HTTPS (nicht HTTP!).');
      }

      if (!discordProbe.ok) {
        hints.push(`${modeUsesLinkPreview ? '🔴' : 'ℹ️'} Discord-Probe ${modeUsesLinkPreview ? 'FEHLER' : 'Hinweis'}: ${discordProbe.error}`);
      } else {
        if (!(discordProbe.status >= 200 && discordProbe.status < 400)) {
          hints.push(`${modeUsesLinkPreview ? '🔴' : 'ℹ️'} Discord-Crawler erhält HTTP ${discordProbe.status} (erwartet: 200-399).`);
        }
        if (!/text\/html/i.test(discordProbe.contentType || '')) {
          hints.push(`${modeUsesLinkPreview ? '🔴' : 'ℹ️'} Content-Type ist nicht text/html (${discordProbe.contentType || 'unbekannt'}).`);
        }
        if (modeUsesLinkPreview && !richPreviewLikely) {
          const missing = [];
          if (!hasOgTitle) missing.push('og:title');
          if (!hasDescription) missing.push('og:description oder <meta name="description">');
          if (!hasImage) missing.push('og:image oder twitter:image');
          hints.push(`🔴 UNZUREICHENDE METADATEN: Fehlend: ${missing.join(', ')}. Discord braucht mindestens Titel + (Beschreibung ODER Bild).`);
        } else if (modeUsesLinkPreview && hasOgTitle && !hasImage) {
          hints.push('🟡 Vorschau ist grundsätzlich möglich, aber ohne Bild oft nur als Text-Link (og:image fehlt).');
        }
        if (discordProbe.challengeDetected) {
          hints.push(`${modeUsesLinkPreview ? '🔴' : 'ℹ️'} Cloudflare-Challenge erkannt - Discord-Crawler wird möglicherweise blockiert!`);
        }
        if (discordProbe.isCloudflareServer && !discordProbe.challengeDetected) {
          hints.push('ℹ️ Server: Cloudflare (CDN). Browser und Discord sehen teils unterschiedliche Cache-Stände.');
        }
      }

      if (defaultProbe.ok && discordProbe.ok && defaultProbe.status !== discordProbe.status) {
        hints.push(`⚠️ unterschiedliche HTTP-Status: Browser=${defaultProbe.status}, Discord=${discordProbe.status} (Crawler-Filter aktiv?).`);
      }

      // Konkrete Lösungsvorschläge
      const solutions = [];
      if (modeUsesLinkPreview && !richPreviewLikely) {
        solutions.push('💡 LÖSUNG: Für zuverlässige Discord-Vorschau müssen Meta-Tags ergänzt werden.');
        solutions.push('  1️⃣ Pflicht: og:title + (og:description ODER og:image). Empfohlen: alle drei Tags setzen.');
        solutions.push('  2️⃣ Bei og:image: absolute HTTPS-URL verwenden (kein relativer Pfad).');
        solutions.push('  3️⃣ Nach Änderungen 2–10 Minuten warten (CDN/Discord Cache) und Diagnose erneut starten.');
        if (currentRenderMode !== 'embed') {
          solutions.push('  4️⃣ Sofort-Workaround: DISCORD_STATUS_RENDER_MODE="embed" setzen (stabil, ohne OG-Abhängigkeit).');
        }
      }
      if (modeUsesLinkPreview && discordProbe.challengeDetected) {
        solutions.push('⚠️ CLOUDFLARE-HERAUSFORDERUNG: Cloudflare blockiert Discord-Crawler!');
        solutions.push('  → Lösung: In Cloudflare Dashboard Bot-Protection/Firewall-Regeln für Discordbot lockern.');
      }
      if (discordProbe.ok && defaultProbe.ok && defaultProbe.status === discordProbe.status && discordProbe.headers?.cfCacheStatus) {
        solutions.push(`ℹ️ Cloudflare Cache-Status: ${discordProbe.headers.cfCacheStatus}. Bei DYNAMIC/BYPASS ist der Ursprung direkt relevant.`);
      }

      res.json({
        ok: true,
        targetUrl,
        currentRenderMode,
        checkedAt: new Date().toISOString(),
        diagnosis: {
          modeUsesLinkPreview,
          richPreviewLikely,
          hasOgTitle,
          hasDescription,
          hasImage,
          hasTwitterCard,
        },
        probes: {
          discord: discordProbe,
          browser: defaultProbe,
        },
        hints,
        solutions,
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
      try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: rootDir, stdio: 'ignore' }); }
      catch { return res.json({ ok: true, hasGit: false, updateAvailable: false }); }

      try { execFileSync('git', ['fetch', 'origin', 'main', '--quiet'], { cwd: rootDir, timeout: 8000, stdio: 'ignore' }); }
      catch { return res.json({ ok: true, hasGit: true, fetchFailed: true, updateAvailable: false }); }

      const behind = parseInt(execFileSync('git', ['rev-list', 'HEAD..origin/main', '--count'], { cwd: rootDir }).toString().trim(), 10) || 0;
      const ahead  = parseInt(execFileSync('git', ['rev-list', 'origin/main..HEAD', '--count'], { cwd: rootDir }).toString().trim(), 10) || 0;
      const local  = execFileSync('git', ['rev-parse', '--short', 'HEAD'],        { cwd: rootDir }).toString().trim();
      const remote = execFileSync('git', ['rev-parse', '--short', 'origin/main'], { cwd: rootDir }).toString().trim();

      let commits = [];
      if (behind > 0) {
        commits = execFileSync(
          'git',
          ['log', 'HEAD..origin/main', '--oneline', '--format=%h|||%s|||%cr'],
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

  // ── API: npm + System-Abhängigkeiten prüfen ─────────────────────────────────

  app.get('/api/deps-check', dashboardAuth, async (req, res) => {
    try {
      const checkCommand = (cmd, args = ['--version']) => {
        try {
          const out = execFileSync(cmd, args, { timeout: 4000 }).toString().trim();
          const line = out.split(/\r?\n/).find(Boolean) || out;
          return { installed: true, version: line || 'vorhanden' };
        } catch {
          return { installed: false, version: null };
        }
      };

      const aptAvailable = (() => {
        try {
          execFileSync('apt-get', ['--version'], { timeout: 3000, stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      })();

      const dockerComposeState = (() => {
        try {
          const out = execSync('docker compose version', { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
          const line = out.split(/\r?\n/).find(Boolean) || out;
          return { installed: true, version: line || 'vorhanden' };
        } catch {
          return { installed: false, version: null };
        }
      })();

      const systemDependencySpecs = [
        {
          key: 'git',
          name: 'git',
          required: true,
          requiredBy: 'Update-Workflow (git pull)',
          aptPackage: 'git',
          state: checkCommand('git')
        },
        {
          key: 'curl',
          name: 'curl',
          required: true,
          requiredBy: 'Updater / Netzwerk-Checks',
          aptPackage: 'curl',
          state: checkCommand('curl')
        },
        {
          key: 'wget',
          name: 'wget',
          required: false,
          requiredBy: 'Healthcheck & Diagnose (optional)',
          aptPackage: 'wget',
          state: checkCommand('wget')
        },
        {
          key: 'node',
          name: 'node',
          required: true,
          requiredBy: 'Bot-Laufzeit',
          aptPackage: 'nodejs npm',
          state: checkCommand('node')
        },
        {
          key: 'npm',
          name: 'npm',
          required: true,
          requiredBy: 'npm install / npm ci',
          aptPackage: 'npm',
          state: checkCommand('npm')
        },
        {
          key: 'rsvg-convert',
          name: 'rsvg-convert',
          required: false,
          requiredBy: 'Discord SVG-Renderer (svg_attachment)',
          aptPackage: 'librsvg2-bin',
          state: checkCommand('rsvg-convert')
        },
        {
          key: 'cloudflared',
          name: 'cloudflared',
          required: false,
          requiredBy: 'Cloudflare Tunnel',
          aptPackage: 'cloudflared',
          state: checkCommand('cloudflared')
        },
        {
          key: 'docker',
          name: 'docker',
          required: false,
          requiredBy: 'Docker-Modus',
          aptPackage: 'docker.io',
          state: checkCommand('docker')
        },
        {
          key: 'docker-compose-plugin',
          name: 'docker compose',
          required: false,
          requiredBy: 'Docker-Modus (compose)',
          aptPackage: 'docker-compose-plugin',
          state: dockerComposeState
        }
      ];

      const systemDeps = systemDependencySpecs.map((dep) => {
        const installCmd = (!dep.state.installed && aptAvailable && dep.aptPackage)
          ? `sudo apt-get install -y ${dep.aptPackage}`
          : '';
        return {
          key: dep.key,
          name: dep.name,
          required: dep.required,
          requiredBy: dep.requiredBy,
          installed: dep.state.installed,
          version: dep.state.version,
          aptPackage: dep.aptPackage || '',
          installCommand: installCmd,
          installable: Boolean(installCmd),
        };
      });

      const pkgPath = path.join(rootDir, 'package.json');
      if (!fs.existsSync(pkgPath)) {
        return res.json({
          ok: true,
          packages: [],
          outdatedCount: 0,
          total: 0,
          warning: 'package.json nicht gefunden',
          systemDeps,
          systemMissingCount: systemDeps.filter(d => !d.installed).length,
          systemRequiredMissingCount: systemDeps.filter(d => d.required && !d.installed).length,
          aptAvailable,
        });
      }

      const safeParseJson = (raw, fallback = {}) => {
        try {
          const text = String(raw ?? '').replace(/^\uFEFF/, '').trim();
          if (!text) return fallback;
          return JSON.parse(text);
        } catch {
          return fallback;
        }
      };

      const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
      const pkg = safeParseJson(pkgRaw, {});
      const allDeps = {
        ...Object.fromEntries(Object.entries(pkg.dependencies    || {}).map(([k, v]) => [k, { required: v, type: 'dependency'    }])),
        ...Object.fromEntries(Object.entries(pkg.devDependencies || {}).map(([k, v]) => [k, { required: v, type: 'devDependency' }])),
      };

      if (Object.keys(allDeps).length === 0) {
        return res.json({
          ok: true,
          packages: [],
          outdatedCount: 0,
          total: 0,
          warning: 'Keine npm-Abhängigkeiten gefunden oder package.json nicht lesbar',
          systemDeps,
          systemMissingCount: systemDeps.filter(d => !d.installed).length,
          systemRequiredMissingCount: systemDeps.filter(d => d.required && !d.installed).length,
          aptAvailable,
        });
      }

      // Robust gegen npm-Notices/Warnungen: parseable statt JSON nutzen.
      // Damit vermeiden wir JSON.parse auf gemischter CLI-Ausgabe komplett.
      let outdated = {};
      await new Promise((resolve) => {
        let rawOut = '';
        const proc = spawn('npm', ['outdated', '--parseable', '--depth=0'], {
          cwd: rootDir,
        });
        proc.stdout.on('data', (chunk) => { rawOut += chunk.toString(); });
        proc.on('close', () => {
          const depNames = Object.keys(allDeps);
          const lines = rawOut.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          for (const line of lines) {
            for (const depName of depNames) {
              const marker = `node_modules/${depName}:`;
              const idx = line.indexOf(marker);
              if (idx === -1) continue;
              const cols = line.slice(idx + marker.length).split(':');
              outdated[depName] = {
                current: cols[0] || null,
                wanted : cols[1] || null,
                latest : cols[2] || null,
              };
              break;
            }
          }
          resolve();
        });
        proc.on('error', () => resolve()); // npm nicht gefunden o.ä.
      });

      // Installierte Version direkt aus node_modules lesen (Fallback wenn outdated leer)
      const getInstalled = (name) => {
        try {
          const p = path.join(rootDir, 'node_modules', name, 'package.json');
          const installedPkg = safeParseJson(fs.readFileSync(p, 'utf8'), {});
          return installedPkg.version || null;
        } catch { return null; }
      };

      const packages = Object.entries(allDeps).map(([name, info]) => {
        const od = outdated[name];
        const installed = od?.current ?? getInstalled(name);
        const curMajor = od ? parseInt((od.current || '0').split('.')[0], 10) : 0;
        const latMajor = od ? parseInt((od.latest  || '0').split('.')[0], 10) : 0;
        return {
          name,
          required : info.required,
          type     : info.type,
          current  : installed,
          wanted   : od?.wanted  ?? null,
          latest   : od?.latest  ?? null,
          outdated : !!od,
          majorBump: od ? (latMajor > curMajor) : false,
        };
      });

      packages.sort((a, b) => (b.outdated - a.outdated) || a.name.localeCompare(b.name));
      const outdatedCount = packages.filter(p => p.outdated).length;
      res.json({
        ok: true,
        packages,
        outdatedCount,
        total: packages.length,
        systemDeps,
        systemMissingCount: systemDeps.filter(d => !d.installed).length,
        systemRequiredMissingCount: systemDeps.filter(d => d.required && !d.installed).length,
        aptAvailable,
      });
    } catch (err) {
      logger.error(`/api/deps-check Fehler: ${err.message}`);
      res.json({ ok: false, error: err.message });
    }
  });

  // ── API: System-Abhängigkeit per apt-get installieren ──────────────────────

  app.post('/api/sys-dep-install', dashboardAuth, (req, res) => {
    // Hardcoded allowlist — key vom Client, aptPackage kommt immer vom Server
    const ALLOWED_SYS_KEYS = {
      'git':                   'git',
      'curl':                  'curl',
      'wget':                  'wget',
      'node':                  'nodejs npm',
      'npm':                   'npm',
      'rsvg-convert':          'librsvg2-bin',
      'cloudflared':           'cloudflared',
      'docker':                'docker.io',
      'docker-compose-plugin': 'docker-compose-plugin',
    };

    const key = req.body?.key;
    if (!key || !Object.prototype.hasOwnProperty.call(ALLOWED_SYS_KEYS, key)) {
      return res.status(400).json({ ok: false, error: 'Ungültiger Abhängigkeits-Schlüssel.' });
    }

    let aptAvailable = false;
    try {
      execFileSync('apt-get', ['--version'], { timeout: 3000, stdio: 'ignore' });
      aptAvailable = true;
    } catch { /* not available */ }

    if (!aptAvailable) {
      return res.status(400).json({ ok: false, error: 'apt-get nicht verfügbar. Manuelle Installation erforderlich.' });
    }

    const aptPackage = ALLOWED_SYS_KEYS[key];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (line) => res.write(`data: ${line.replace(/\n/g, ' ')}\n\n`);

    send(`[Dashboard] sudo apt-get install -y ${aptPackage}`);
    const proc = spawn('sudo', ['apt-get', 'install', '-y', ...aptPackage.split(' ')], {
      env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
    });
    proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(send));
    proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(send));
    proc.on('close', code => { res.write(`data: __EXIT__:${code}\n\n`); res.end(); });
  });

  // ── API: Update ausführen (Server-Sent Events) ──────────────────────────────

  app.post('/api/update-run', dashboardAuth, (req, res) => {
    const ALLOWED_MODES = ['auto', 'native', 'docker'];
    const ALLOWED_TASKS = ['full', 'git', 'npm'];
    const mode       = ALLOWED_MODES.includes(req.body?.mode) ? req.body.mode : 'auto';
    const task       = ALLOWED_TASKS.includes(req.body?.task) ? req.body.task : 'full';
    const scriptPath = path.join(rootDir, 'update.sh');

    if (!fs.existsSync(scriptPath))
      return res.json({ ok: false, error: 'update.sh nicht gefunden' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const args = [scriptPath, '--bot-dir', rootDir, '--mode', mode, '--yes'];
    if (task === 'git') args.push('--skip-npm');
    if (task === 'npm') args.push('--skip-git');

    const proc = spawn('bash', args, { cwd: rootDir });
    const send = (line) => res.write(`data: ${line.replace(/\n/g, ' ')}\n\n`);
    proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(send));
    proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(send));
    proc.on('close', code => { res.write(`data: __EXIT__:${code}\n\n`); res.end(); });
  });

  // ── API: Vorhandene Discord-Kategorien/Kanäle lesen ───────────────────────

  app.get('/api/discord-channel-browser', dashboardAuth, async (req, res) => {
    try {
      if (!client.isReady()) {
        return res.json({ ok: false, error: 'Discord-Client ist nicht bereit. Bot online?' });
      }

      const cfgServiceGuildId = String(config.get('discord.serviceGuildId') || '').trim();
      const cfgGuildId = String(config.get('discord.guildId') || '').trim();
      const reqGuildId = String(req.query?.guildId || '').trim();
      const guildId = reqGuildId || cfgServiceGuildId || cfgGuildId;

      if (!guildId || !/^\d+$/.test(guildId)) {
        return res.json({ ok: false, error: 'Guild-ID fehlt oder ist ungültig.' });
      }

      let guild = client.guilds.cache.get(guildId);
      if (!guild) guild = await client.guilds.fetch(guildId);
      if (!guild) return res.json({ ok: false, error: 'Guild nicht gefunden.' });

      await guild.channels.fetch();

      const all = Array.from(guild.channels.cache.values());
      const categories = all
        .filter(ch => ch?.type === ChannelType.GuildCategory)
        .sort((a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0));

      const textChannels = all
        .filter(ch => ch?.type === ChannelType.GuildText)
        .sort((a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0));

      const byCategory = categories.map((cat) => {
        const channels = textChannels
          .filter(ch => ch.parentId === cat.id)
          .map(ch => ({ id: ch.id, name: ch.name }));
        return {
          id: cat.id,
          name: cat.name,
          channels,
        };
      });

      const uncategorized = textChannels
        .filter(ch => !ch.parentId)
        .map(ch => ({ id: ch.id, name: ch.name }));

      res.json({
        ok: true,
        guild: { id: guild.id, name: guild.name },
        categories: byCategory,
        uncategorized,
      });
    } catch (err) {
      logger.error(`/api/discord-channel-browser Fehler: ${err.message}`);
      res.json({ ok: false, error: err.message });
    }
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
      const maskSecret = (value) => {
        if (!value) return '';
        if (value.length > 12) return `${value.slice(0, 6)}${'*'.repeat(value.length - 12)}${value.slice(-6)}`;
        return '***';
      };

      const token = get('DISCORD_TOKEN');
      const apiKey = get('UPTIME_KUMA_API_KEY');
      const webhookUrl = get('DISCORD_STATUS_WEBHOOK_URL');
      const dashboardPassword = get('DASHBOARD_PASSWORD');
      const translateApiKey = get('DISCORD_TRANSLATE_API_KEY');

      res.json({
        ok: true,
        DISCORD_TOKEN:                maskSecret(token),
        DISCORD_BOT_NAME:             get('DISCORD_BOT_NAME') || '',
        DISCORD_PRESENCE_TEXT:        get('DISCORD_PRESENCE_TEXT') || 'Service Health',
        DISCORD_PRESENCE_ROTATE_MS:   get('DISCORD_PRESENCE_ROTATE_MS') || '90000',
        DISCORD_AUTO_REACTION_ENABLED:get('DISCORD_AUTO_REACTION_ENABLED') || 'false',
        DISCORD_AUTO_REACTION_EMOJIS: get('DISCORD_AUTO_REACTION_EMOJIS') || '👍',
        DISCORD_AUTO_REACTION_CHANNEL_IDS: get('DISCORD_AUTO_REACTION_CHANNEL_IDS') || '',
        DISCORD_ENABLED_COMMANDS:     get('DISCORD_ENABLED_COMMANDS') || 'status,uptime,refresh,help,coinflip,dice,eightball,cleanup,translate',
        DISCORD_TRANSLATE_ENABLED:    get('DISCORD_TRANSLATE_ENABLED') || 'false',
        DISCORD_TRANSLATE_DEFAULT_TARGET: get('DISCORD_TRANSLATE_DEFAULT_TARGET') || 'de',
        DISCORD_TRANSLATE_DEFAULT_SOURCE: get('DISCORD_TRANSLATE_DEFAULT_SOURCE') || 'auto',
        DISCORD_TRANSLATE_API_URL:    get('DISCORD_TRANSLATE_API_URL') || 'https://libretranslate.com/translate',
        DISCORD_TRANSLATE_API_KEY:    maskSecret(translateApiKey),
        DISCORD_TRANSLATE_ALLOWED_GUILD_IDS: get('DISCORD_TRANSLATE_ALLOWED_GUILD_IDS') || '',
        DISCORD_TRANSLATE_MAX_TEXT_LENGTH: get('DISCORD_TRANSLATE_MAX_TEXT_LENGTH') || '1800',
        STATUS_CHANNEL_ID:            get('STATUS_CHANNEL_ID'),
        DISCORD_NOTIFICATION_CHANNEL: get('DISCORD_NOTIFICATION_CHANNEL'),
        DISCORD_STATUS_RENDER_MODE:   get('DISCORD_STATUS_RENDER_MODE') || 'auto',
        DISCORD_STATUS_MESSAGE_TITLE: get('DISCORD_STATUS_MESSAGE_TITLE') || '',
        DISCORD_STATUS_BUTTON_LABEL:  get('DISCORD_STATUS_BUTTON_LABEL') || 'Statusseite öffnen',
        DISCORD_WEBUI_BUTTON_LABEL:   get('DISCORD_WEBUI_BUTTON_LABEL') || '',
        DISCORD_STATUS_WEBHOOK_URL:   maskSecret(webhookUrl),
        UPTIME_KUMA_URL:              get('UPTIME_KUMA_URL'),
        UPTIME_KUMA_API_KEY:          maskSecret(apiKey),
        STATUS_PAGE_SLUG:             get('STATUS_PAGE_SLUG') || 'dienste',
        CLOUDFLARE_PUBLIC_URL:        get('CLOUDFLARE_PUBLIC_URL'),
        CHANNEL_STATUS_INDICATOR:     get('CHANNEL_STATUS_INDICATOR') || 'true',
        GUILD_ID:                     get('GUILD_ID'),
        SERVICE_GUILD_ID:             get('SERVICE_GUILD_ID') || '',
        SERVICE_CATEGORY_NAME:        get('SERVICE_CATEGORY_NAME'),
        SERVICE_CATEGORY_ID:          get('SERVICE_CATEGORY_ID'),
        SERVICE_CHANNEL_NAME_MODE:    get('SERVICE_CHANNEL_NAME_MODE') || 'strict_slug',
        SERVICE_CHANNEL_AUTO_CREATE:  get('SERVICE_CHANNEL_AUTO_CREATE') || 'true',
        SERVICE_CHANNEL_AUTO_QUIET:   get('SERVICE_CHANNEL_AUTO_QUIET') || 'true',
        SERVICE_CHANNEL_MAP:          get('SERVICE_CHANNEL_MAP') || '',
        MONITORED_SERVICES:           get('MONITORED_SERVICES'),
        MESSAGE_CLEANUP_ENABLED:      get('MESSAGE_CLEANUP_ENABLED') || 'false',
        MESSAGE_CLEANUP_CHANNEL_IDS:  get('MESSAGE_CLEANUP_CHANNEL_IDS') || '',
        MESSAGE_CLEANUP_MAX_MESSAGES: get('MESSAGE_CLEANUP_MAX_MESSAGES') || '4',
        MESSAGE_CLEANUP_MAX_AGE_HOURS:get('MESSAGE_CLEANUP_MAX_AGE_HOURS') || '12',
        MESSAGE_CLEANUP_ONLY_BOT_MESSAGES: get('MESSAGE_CLEANUP_ONLY_BOT_MESSAGES') || 'true',
        MESSAGE_CLEANUP_INTERVAL_MS:  get('MESSAGE_CLEANUP_INTERVAL_MS') || '300000',
        SERVICE_CHANNEL_DEBUG:        get('SERVICE_CHANNEL_DEBUG') || 'false',
        SERVICE_CHANNEL_DEBUG_FILTER: get('SERVICE_CHANNEL_DEBUG_FILTER') || '',
        UPDATE_INTERVAL:              get('UPDATE_INTERVAL') || '300000',
        WEB_PORT:                     get('WEB_PORT') || '3000',
        DASHBOARD_PASSWORD:           maskSecret(dashboardPassword),
        DB_DIALECT:                   get('DB_DIALECT') || 'sqlite',
        DB_STORAGE:                   get('DB_STORAGE') || './data/status.db',
      });
    } catch (err) {
      logger.error(`/api/config GET Fehler: ${err.message}`);
      res.json({ ok: false, error: err.message });
    }
  });

  // ── API: Konfiguration schreiben + Bot neu starten ──────────────────────────

  app.post('/api/config', dashboardAuth, (req, res) => {
    const ALLOWED_CFG = [
      'DISCORD_TOKEN',
      'DISCORD_BOT_NAME',
      'DISCORD_PRESENCE_TEXT',
      'DISCORD_PRESENCE_ROTATE_MS',
      'DISCORD_AUTO_REACTION_ENABLED',
      'DISCORD_AUTO_REACTION_EMOJIS',
      'DISCORD_AUTO_REACTION_CHANNEL_IDS',
      'DISCORD_ENABLED_COMMANDS',
      'DISCORD_TRANSLATE_ENABLED',
      'DISCORD_TRANSLATE_DEFAULT_TARGET',
      'DISCORD_TRANSLATE_DEFAULT_SOURCE',
      'DISCORD_TRANSLATE_API_URL',
      'DISCORD_TRANSLATE_API_KEY',
      'DISCORD_TRANSLATE_ALLOWED_GUILD_IDS',
      'DISCORD_TRANSLATE_MAX_TEXT_LENGTH',
      'STATUS_CHANNEL_ID',
      'DISCORD_NOTIFICATION_CHANNEL',
      'DISCORD_STATUS_RENDER_MODE',
      'DISCORD_STATUS_MESSAGE_TITLE',
      'DISCORD_STATUS_BUTTON_LABEL',
      'DISCORD_WEBUI_BUTTON_LABEL',
      'DISCORD_BOT_NAME',
      'DISCORD_STATUS_WEBHOOK_URL',
      'UPTIME_KUMA_URL',
      'UPTIME_KUMA_API_KEY',
      'STATUS_PAGE_SLUG',
      'CLOUDFLARE_PUBLIC_URL',
      'CHANNEL_STATUS_INDICATOR',
      'GUILD_ID',
      'SERVICE_GUILD_ID',
      'SERVICE_CATEGORY_NAME',
      'SERVICE_CATEGORY_ID',
      'SERVICE_CHANNEL_NAME_MODE',
      'SERVICE_CHANNEL_AUTO_CREATE',
      'SERVICE_CHANNEL_AUTO_QUIET',
      'SERVICE_CHANNEL_MAP',
      'MONITORED_SERVICES',
      'MESSAGE_CLEANUP_ENABLED',
      'MESSAGE_CLEANUP_CHANNEL_IDS',
      'MESSAGE_CLEANUP_MAX_MESSAGES',
      'MESSAGE_CLEANUP_MAX_AGE_HOURS',
      'MESSAGE_CLEANUP_ONLY_BOT_MESSAGES',
      'MESSAGE_CLEANUP_INTERVAL_MS',
      'SERVICE_CHANNEL_DEBUG',
      'SERVICE_CHANNEL_DEBUG_FILTER',
      'UPDATE_INTERVAL',
      'WEB_PORT',
      'DASHBOARD_PASSWORD',
      'DB_DIALECT',
      'DB_STORAGE'
    ];
    const CLEARABLE_CFG = new Set([
      'DISCORD_PRESENCE_TEXT',
      'DISCORD_AUTO_REACTION_EMOJIS',
      'DISCORD_AUTO_REACTION_CHANNEL_IDS',
      'DISCORD_STATUS_MESSAGE_TITLE',
      'DISCORD_STATUS_BUTTON_LABEL',
      'DISCORD_WEBUI_BUTTON_LABEL',
      'DISCORD_STATUS_WEBHOOK_URL',
      'DISCORD_TRANSLATE_API_KEY',
      'UPTIME_KUMA_API_KEY',
      'CLOUDFLARE_PUBLIC_URL',
      'DASHBOARD_PASSWORD',
      'SERVICE_CATEGORY_ID',
      'SERVICE_CHANNEL_MAP',
      'MONITORED_SERVICES',
      'MESSAGE_CLEANUP_CHANNEL_IDS',
      'SERVICE_CHANNEL_DEBUG_FILTER',
      'DISCORD_TRANSLATE_ALLOWED_GUILD_IDS'
    ]);
    const envPath = path.join(rootDir, '.env');
    if (!fs.existsSync(envPath)) return res.json({ ok: false, error: '.env nicht gefunden' });

    const updates = {};
    for (const key of ALLOWED_CFG) {
      const raw = req.body?.[key];
      if (raw === undefined || raw === null) continue;

      if (raw === '' && CLEARABLE_CFG.has(key)) {
        updates[key] = '';
        continue;
      }

      if (raw === '') continue;

      const val = String(raw).trim();
      if (key === 'DISCORD_TOKEN' || key === 'UPTIME_KUMA_API_KEY' || key === 'DISCORD_STATUS_WEBHOOK_URL' || key === 'DASHBOARD_PASSWORD' || key === 'DISCORD_TRANSLATE_API_KEY') {
        if (val.includes('*')) continue;
        if (/[\n\r]/.test(val)) return res.json({ ok: false, error: 'Ungültiger Token (enthält Zeilenumbruch)' });
      }
      if (key === 'DISCORD_BOT_NAME') {
        if (/[\n\r]/.test(val)) return res.json({ ok: false, error: 'DISCORD_BOT_NAME darf keine Zeilenumbrüche enthalten' });
        if (val.length > 32) return res.json({ ok: false, error: 'DISCORD_BOT_NAME darf maximal 32 Zeichen enthalten' });
      }
      if (key === 'DISCORD_PRESENCE_TEXT') {
        if (/[\n\r]/.test(val)) return res.json({ ok: false, error: 'DISCORD_PRESENCE_TEXT darf keine Zeilenumbrueche enthalten' });
        if (val.length > 300) return res.json({ ok: false, error: 'DISCORD_PRESENCE_TEXT darf maximal 300 Zeichen enthalten' });
      }
      if (key === 'DISCORD_PRESENCE_ROTATE_MS') {
        const n = parseInt(val, 10);
        if (!Number.isFinite(n) || n < 15000 || n > 3600000)
          return res.json({ ok: false, error: 'DISCORD_PRESENCE_ROTATE_MS muss zwischen 15000 und 3600000 liegen' });
      }
      if (key === 'DISCORD_AUTO_REACTION_ENABLED' && !['true', 'false'].includes(val))
        return res.json({ ok: false, error: 'DISCORD_AUTO_REACTION_ENABLED muss true oder false sein' });
      if (key === 'DISCORD_AUTO_REACTION_EMOJIS') {
        if (/[\n\r]/.test(val)) return res.json({ ok: false, error: 'DISCORD_AUTO_REACTION_EMOJIS darf keine Zeilenumbrueche enthalten' });
        const entries = val.split(/[;,]/).map(s => s.trim()).filter(Boolean);
        if (!entries.length) return res.json({ ok: false, error: 'DISCORD_AUTO_REACTION_EMOJIS muss mindestens ein Emoji enthalten' });
        if (entries.length > 5) return res.json({ ok: false, error: 'DISCORD_AUTO_REACTION_EMOJIS erlaubt maximal 5 Emojis' });
      }
      if (key === 'DISCORD_AUTO_REACTION_CHANNEL_IDS') {
        const entries = val.split(/[;,]/).map(s => s.trim()).filter(Boolean);
        const invalid = entries.filter(id => !/^\d+$/.test(id));
        if (invalid.length) return res.json({ ok: false, error: `DISCORD_AUTO_REACTION_CHANNEL_IDS ungueltig: ${invalid.join(', ')}` });
      }
      if (key === 'DISCORD_ENABLED_COMMANDS') {
        const allowedCommands = new Set(['status', 'uptime', 'refresh', 'help', 'coinflip', 'dice', 'eightball', 'cleanup', 'translate']);
        const entries = val.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const uniqueEntries = Array.from(new Set(entries));
        if (!uniqueEntries.length) {
          return res.json({ ok: false, error: 'DISCORD_ENABLED_COMMANDS muss mindestens ein Kommando enthalten' });
        }
        const invalid = uniqueEntries.filter(cmd => !allowedCommands.has(cmd));
        if (invalid.length) {
          return res.json({ ok: false, error: `DISCORD_ENABLED_COMMANDS enthält ungültige Kommandos: ${invalid.join(', ')}` });
        }
        updates[key] = uniqueEntries.join(',');
        continue;
      }
      if (key === 'DISCORD_TRANSLATE_ENABLED' && !['true', 'false'].includes(val))
        return res.json({ ok: false, error: 'DISCORD_TRANSLATE_ENABLED muss true oder false sein' });
      if ((key === 'DISCORD_TRANSLATE_DEFAULT_TARGET' || key === 'DISCORD_TRANSLATE_DEFAULT_SOURCE')) {
        if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(val) && !(key === 'DISCORD_TRANSLATE_DEFAULT_SOURCE' && val.toLowerCase() === 'auto')) {
          return res.json({ ok: false, error: `${key} muss auto (nur Quelle) oder Sprachcode wie de/en/fr sein` });
        }
      }
      if (key === 'DISCORD_TRANSLATE_API_URL' && !/^https?:\/\/.+/.test(val))
        return res.json({ ok: false, error: 'DISCORD_TRANSLATE_API_URL muss mit http:// oder https:// beginnen' });
      if (key === 'DISCORD_TRANSLATE_ALLOWED_GUILD_IDS') {
        const entries = val.split(/[;,]/).map(s => s.trim()).filter(Boolean);
        const invalid = entries.filter(id => !/^\d+$/.test(id));
        if (invalid.length) return res.json({ ok: false, error: `DISCORD_TRANSLATE_ALLOWED_GUILD_IDS ungueltig: ${invalid.join(', ')}` });
      }
      if (key === 'DISCORD_TRANSLATE_MAX_TEXT_LENGTH') {
        const n = parseInt(val, 10);
        if (!Number.isFinite(n) || n < 64 || n > 4000)
          return res.json({ ok: false, error: 'DISCORD_TRANSLATE_MAX_TEXT_LENGTH muss zwischen 64 und 4000 liegen' });
      }
      if ((key === 'STATUS_CHANNEL_ID' || key === 'DISCORD_NOTIFICATION_CHANNEL') && !/^\d+$/.test(val))
        return res.json({ ok: false, error: `${key}: Nur Zahlen erlaubt (Discord ID)` });
      if (key === 'DISCORD_STATUS_RENDER_MODE' && !['auto', 'direct', 'graphical', 'svg_attachment', 'webhook_ascii', 'embed', 'link_preview'].includes(val))
        return res.json({ ok: false, error: 'DISCORD_STATUS_RENDER_MODE muss auto, direct, graphical, svg_attachment, webhook_ascii, embed oder link_preview sein' });
      if ((key === 'DISCORD_STATUS_MESSAGE_TITLE' || key === 'DISCORD_STATUS_BUTTON_LABEL' || key === 'DISCORD_WEBUI_BUTTON_LABEL') && /[\n\r]/.test(val))
        return res.json({ ok: false, error: `${key} darf keine Zeilenumbrüche enthalten` });
      if ((key === 'DISCORD_STATUS_BUTTON_LABEL' || key === 'DISCORD_WEBUI_BUTTON_LABEL') && val.length > 80)
        return res.json({ ok: false, error: `${key} darf maximal 80 Zeichen enthalten` });
      if ((key === 'DISCORD_STATUS_WEBHOOK_URL' || key === 'CLOUDFLARE_PUBLIC_URL') && val && !/^https?:\/\/.+/.test(val))
        return res.json({ ok: false, error: `${key} muss mit http:// oder https:// beginnen` });
      if (key === 'UPTIME_KUMA_URL' && !/^https?:\/\/.+/.test(val))
        return res.json({ ok: false, error: 'UPTIME_KUMA_URL muss mit http:// oder https:// beginnen' });
      if (key === 'STATUS_PAGE_SLUG' && !/^[a-z0-9-]+$/i.test(val))
        return res.json({ ok: false, error: 'STATUS_PAGE_SLUG darf nur Buchstaben, Zahlen und Bindestriche enthalten' });
      if (key === 'CHANNEL_STATUS_INDICATOR' && !['true', 'false'].includes(val))
        return res.json({ ok: false, error: 'CHANNEL_STATUS_INDICATOR muss true oder false sein' });
      if (key === 'GUILD_ID' && val && !/^\d+$/.test(val))
        return res.json({ ok: false, error: 'GUILD_ID: Nur Zahlen erlaubt (Discord ID)' });
      if (key === 'SERVICE_GUILD_ID' && val && !/^\d+$/.test(val))
        return res.json({ ok: false, error: 'SERVICE_GUILD_ID: Nur Zahlen erlaubt (Discord ID)' });
      if (key === 'SERVICE_CATEGORY_ID' && val && !/^\d+$/.test(val))
        return res.json({ ok: false, error: 'SERVICE_CATEGORY_ID: Nur Zahlen erlaubt (Discord ID)' });
      if (key === 'SERVICE_CHANNEL_NAME_MODE' && !['strict_slug', 'pretty', 'mono'].includes(val))
        return res.json({ ok: false, error: 'SERVICE_CHANNEL_NAME_MODE muss strict_slug, pretty oder mono sein' });
      if (key === 'SERVICE_CHANNEL_AUTO_CREATE' && !['true', 'false'].includes(val))
        return res.json({ ok: false, error: 'SERVICE_CHANNEL_AUTO_CREATE muss true oder false sein' });
      if (key === 'SERVICE_CHANNEL_AUTO_QUIET' && !['true', 'false'].includes(val))
        return res.json({ ok: false, error: 'SERVICE_CHANNEL_AUTO_QUIET muss true oder false sein' });
      if (key === 'MESSAGE_CLEANUP_ENABLED' && !['true', 'false'].includes(val))
        return res.json({ ok: false, error: 'MESSAGE_CLEANUP_ENABLED muss true oder false sein' });
      if (key === 'MESSAGE_CLEANUP_ONLY_BOT_MESSAGES' && !['true', 'false'].includes(val))
        return res.json({ ok: false, error: 'MESSAGE_CLEANUP_ONLY_BOT_MESSAGES muss true oder false sein' });
      if (key === 'MESSAGE_CLEANUP_CHANNEL_IDS') {
        const entries = val.split(/[;,]/).map(s => s.trim()).filter(Boolean);
        const invalid = entries.filter(id => !/^\d+$/.test(id));
        if (invalid.length) {
          return res.json({ ok: false, error: `MESSAGE_CLEANUP_CHANNEL_IDS ungueltig: ${invalid.join(', ')}` });
        }
      }
      if (key === 'MESSAGE_CLEANUP_MAX_MESSAGES') {
        const n = parseInt(val, 10);
        if (!Number.isFinite(n) || n < 0 || n > 200)
          return res.json({ ok: false, error: 'MESSAGE_CLEANUP_MAX_MESSAGES muss zwischen 0 und 200 liegen' });
      }
      if (key === 'MESSAGE_CLEANUP_MAX_AGE_HOURS') {
        const n = parseInt(val, 10);
        if (!Number.isFinite(n) || n < 0 || n > 720)
          return res.json({ ok: false, error: 'MESSAGE_CLEANUP_MAX_AGE_HOURS muss zwischen 0 und 720 liegen' });
      }
      if (key === 'MESSAGE_CLEANUP_INTERVAL_MS') {
        const n = parseInt(val, 10);
        if (!Number.isFinite(n) || n < 60000 || n > 86400000)
          return res.json({ ok: false, error: 'MESSAGE_CLEANUP_INTERVAL_MS muss zwischen 60000 und 86400000 liegen' });
      }
      if (key === 'SERVICE_CHANNEL_DEBUG' && !['true', 'false'].includes(val))
        return res.json({ ok: false, error: 'SERVICE_CHANNEL_DEBUG muss true oder false sein' });
      if (key === 'SERVICE_CHANNEL_DEBUG_FILTER') {
        if (/[\n\r]/.test(val))
          return res.json({ ok: false, error: 'SERVICE_CHANNEL_DEBUG_FILTER darf keine Zeilenumbrüche enthalten' });
        if (val.length > 300)
          return res.json({ ok: false, error: 'SERVICE_CHANNEL_DEBUG_FILTER darf maximal 300 Zeichen enthalten' });
      }
      if (key === 'SERVICE_CHANNEL_MAP') {
        const entries = val.split(';').map(s => s.trim()).filter(Boolean);
        for (const entry of entries) {
          const idx = entry.lastIndexOf('=');
          if (idx <= 0) {
            return res.json({ ok: false, error: 'SERVICE_CHANNEL_MAP Format: Monitor=123456;Anderer Monitor=987654' });
          }
          const monitorName = entry.slice(0, idx).trim();
          const channelId = entry.slice(idx + 1).trim();
          if (!monitorName) {
            return res.json({ ok: false, error: 'SERVICE_CHANNEL_MAP: Monitorname darf nicht leer sein' });
          }
          if (!/^\d+$/.test(channelId)) {
            return res.json({ ok: false, error: `SERVICE_CHANNEL_MAP: Channel-ID ungültig bei "${monitorName}"` });
          }
        }
      }
      if (key === 'UPDATE_INTERVAL') {
        const n = parseInt(val, 10);
        if (!Number.isFinite(n) || n < 10000)
          return res.json({ ok: false, error: 'UPDATE_INTERVAL muss eine Zahl >= 10000 sein' });
      }
      if (key === 'WEB_PORT') {
        const n = parseInt(val, 10);
        if (!Number.isFinite(n) || n < 1 || n > 65535)
          return res.json({ ok: false, error: 'WEB_PORT muss zwischen 1 und 65535 liegen' });
      }
      if (key === 'DB_DIALECT' && val !== 'sqlite')
        return res.json({ ok: false, error: 'DB_DIALECT darf aktuell nur sqlite sein' });
      if (key === 'DB_STORAGE' && /[\n\r]/.test(val))
        return res.json({ ok: false, error: 'DB_STORAGE darf keine Zeilenumbrüche enthalten' });

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

  // ── API: Container-/Service-Erkennung ─────────────────────────────────────
  app.get('/api/container-detection', dashboardAuth, async (req, res) => {
    const result = {
      ok: true,
      docker: { available: false, version: null },
      uptimeKuma:     { found: false, via: null, name: null, status: null, ports: null, reachable: false, url: null },
      libretranslate: { found: false, via: null, name: null, status: null, ports: null, reachable: false, url: null, languageCount: null }
    };

    // Docker verfügbar?
    try {
      const v = execFileSync('docker', ['version', '--format', '{{.Server.Version}}'],
        { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      result.docker.available = true;
      result.docker.version = v || 'vorhanden';
    } catch { /* Docker nicht installiert */ }

    // Laufende Container prüfen
    if (result.docker.available) {
      try {
        const out = execFileSync('docker', ['ps', '--format', '{{.Names}}|||{{.Status}}|||{{.Ports}}'],
          { timeout: 5000 }).toString().trim();
        for (const line of out.split('\n').filter(Boolean)) {
          const [name = '', status = '', ports = ''] = line.split('|||');
          const nl = name.toLowerCase();
          if (nl.includes('uptime') || nl.includes('kuma')) {
            result.uptimeKuma = { found: true, via: 'docker', name, status, ports };
          }
          if (nl.includes('libretranslate') || nl.includes('libre-translate')) {
            result.libretranslate = { found: true, via: 'docker', name, status, ports };
          }
        }
      } catch { /* docker ps optional */ }
    }

    // Systemd-Fallback für uptime-kuma
    if (!result.uptimeKuma.found) {
      try {
        const state = execFileSync('systemctl', ['is-active', 'uptime-kuma'], { timeout: 4000 }).toString().trim();
        if (state === 'active') {
          result.uptimeKuma = { found: true, via: 'systemd', name: 'uptime-kuma', status: state, ports: null };
        }
      } catch { /* kein systemd-Service */ }
    }

    // HTTP-Probe: Uptime Kuma
    const kumaBase = (config.get('uptimeKuma.url') || '').replace(/\/$/, '');
    if (kumaBase) {
      result.uptimeKuma.url = kumaBase;
      try {
        await axios.get(kumaBase, { timeout: 3000 });
        result.uptimeKuma.reachable = true;
      } catch (e) {
        result.uptimeKuma.reachable = !!(e.response); // HTTP-Antwort = erreichbar
      }
    }

    // HTTP-Probe: LibreTranslate
    const ltBase = (config.get('discord.translateApiUrl') || '').replace(/\/translate$/, '').replace(/\/$/, '');
    if (ltBase) {
      result.libretranslate.url = ltBase;
      try {
        const r = await axios.get(`${ltBase}/languages`, { timeout: 3000 });
        result.libretranslate.reachable = true;
        result.libretranslate.languageCount = Array.isArray(r.data) ? r.data.length : null;
      } catch (e) {
        result.libretranslate.reachable = !!(e.response);
      }
    }

    res.json(result);
  });

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

  // ── API: Status-Unfurl-Proxy (für direct render mode) ─────────────────────
  // Discord-Crawler ruft diese URL ab und bekommt eine HTML-Seite mit injizierten
  // OG-Metadaten: aktueller Servicestatus als og:title, og:description, og:image.

  app.get('/api/status-unfurl', async (req, res) => {
    try {
      const monitors = await getMonitorData();
      const active   = (monitors || []).filter(m => m.active !== false);
      const up       = active.filter(m => m.status === 1).length;
      const total    = active.length;
      const anyDown    = active.some(m => m.status === 0);
      const anyPending = active.some(m => m.status === 2);

      const statusEmoji = anyDown ? '🔴' : anyPending ? '🟡' : '🟢';
      const statusText  = anyDown ? 'OUTAGE' : anyPending ? 'PENDING' : 'All systems operational';
      const ogTitle     = `${statusEmoji} Service Status — ${statusText}`;
      const ogDesc      = `${up}/${total} Dienste online · ${new Date().toLocaleString('de-DE', { hour12: false })}`;

      const canonicalUrl = getPublicStatusUrl() || config.get('uptimeKuma.url') || '';
      const pubBase      = (config.get('cloudflare.publicUrl') || '').replace(/\/+$/, '')
                        || `http://localhost:${config.get('webPort')}`;
      const badgeUrl     = `${pubBase}/api/badge/summary`;

      // Escape HTML-Sonderzeichen damit kein XSS in Attributwerten möglich ist
      const esc = s => String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Service Status">
  <meta property="og:title" content="${esc(ogTitle)}">
  <meta property="og:description" content="${esc(ogDesc)}">
  <meta property="og:image" content="${esc(badgeUrl)}">
  <meta property="og:url" content="${esc(canonicalUrl)}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${esc(ogTitle)}">
  <meta name="twitter:description" content="${esc(ogDesc)}">
  <meta name="twitter:image" content="${esc(badgeUrl)}">
  <meta http-equiv="refresh" content="0; url=${esc(canonicalUrl)}">
  <title>${esc(ogTitle)}</title>
</head>
<body>
  <p>Weiterleitung zur <a href="${esc(canonicalUrl)}">Statusseite</a>…</p>
</body>
</html>`;

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=270'); // ~5-Minuten-Bucket passend zum Poll-Interval
      res.send(html);
    } catch (err) {
      logger.error(`/api/status-unfurl Fehler: ${err.message}`);
      res.status(500).send('Internal Server Error');
    }
  });

  // ── API: Status-Badge SVG (für graphical render mode / og:image) ───────────
  // Gibt ein Shield.io-kompatibles SVG-Badge zurück, das den aktuellen
  // Service-Gesamtstatus ("X/Y up") als farbigen Badge darstellt.

  app.get('/api/badge/summary', async (req, res) => {
    try {
      const monitors = await getMonitorData();
      const active   = (monitors || []).filter(m => m.active !== false);
      const up       = active.filter(m => m.status === 1).length;
      const total    = active.length;
      const anyDown    = active.some(m => m.status === 0);
      const anyPending = active.some(m => m.status === 2);

      const label = 'services';
      const value = total > 0 ? `${up}/${total} up` : 'unknown';
      const color = anyDown ? '#e05252' : anyPending ? '#e09b42' : '#3fb950';

      const lw = 70;  // Breite Label-Block (px)
      const vw = 62;  // Breite Value-Block (px)
      const tw = lw + vw;
      const h  = 20;

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${h}" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0"  stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1"  stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${tw}" height="${h}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="${h}" fill="#555"/>
    <rect x="${lw}" width="${vw}" height="${h}" fill="${color}"/>
    <rect width="${tw}" height="${h}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${lw / 2}" y="14" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${lw / 2}" y="13">${label}</text>
    <text x="${lw + vw / 2}" y="14" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${lw + vw / 2}" y="13">${value}</text>
  </g>
</svg>`;

      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=270');
      res.send(svg);
    } catch (err) {
      logger.error(`/api/badge/summary Fehler: ${err.message}`);
      res.status(500).end();
    }
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
