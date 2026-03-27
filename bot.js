/**
 * Bockis Discord Bot
 * Copyright (c) 2026 ReXx09 (https://github.com/ReXx09)
 *
 * This software is licensed under the MIT License.
 * See the LICENSE file in the project root for full license details.
 *
 * SPDX-License-Identifier: MIT
 */

require('dotenv').config();
const { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const winston = require('winston');
require('winston-daily-rotate-file');
const prom = require('prom-client');
const { Sequelize, DataTypes, Op } = require('sequelize');
const fs = require('fs');

// #region 1. ENV-VALIDIERUNG
const path = require('path');
const envPath = path.join(__dirname, '.env');
const envExamplePath = path.join(__dirname, '.env.example');
const dotenvExists = fs.existsSync(envPath);

if (dotenvExists) {
  require('dotenv').config();
} else {
  console.warn('[INFO] Keine .env gefunden – Umgebungsvariablen werden von außen erwartet (Docker-Compose, systemd, Host-Env)');
}

const REQUIRED_ENV = ['DISCORD_TOKEN', 'STATUS_CHANNEL_ID', 'UPTIME_KUMA_URL'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error(`[FATAL] Fehlende Umgebungsvariablen: ${missingEnv.join(', ')}`);
  console.error('\nSo behebst du das:');
  console.error('  1. Lokal: Kopiere .env.example zu .env und f\u00fclle die Werte aus');
  console.error('     $ cp .env.example .env');  
  console.error('  2. Docker: Setze die Variablen in docker-compose.yml oder Host-ENV');
  process.exit(1);
}
// #endregion

// #region 2. LOGGER MIT LOG-ROTATION
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.DailyRotateFile({
      filename: 'logs/bot-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '10m',
      maxFiles: '14d',
      zippedArchive: true
    })
  ]
});
// #endregion

// #region 3. KONFIGURATION
const config = require('./config/config');
// #endregion

// #region 4. DATENBANK-INITIALISIERUNG
const sequelize = new Sequelize(config.get('database'));
const MonitorStatus = require('./models/MonitorStatus')(sequelize, DataTypes);
// #endregion

// #region 5. PROMETHEUS METRIKEN
const collectDefaultMetrics = prom.collectDefaultMetrics;
collectDefaultMetrics({ timeout: 5000 });

const statusCheckCounter = new prom.Counter({
  name: 'status_checks_total',
  help: 'Total number of status checks'
});

const uptimeGauge = new prom.Gauge({
  name: 'service_uptime_percent',
  help: 'Current uptime percentage'
});
// #endregion

// #region 6. WEB-SERVER
// Express-App-Erstellung, Middleware, Routen und HTTP-Listen sind vollständig
// in web/routes.js ausgelagert. startWebServer() wird in Region 24 aufgerufen.
const startWebServer = require('./web/routes');
// #endregion

// #region 7. SERVICE-STATUS THEME
const STATUS_THEME = {
  online: {
    color: 0x43B581,
    icon: '\uD83D\uDFE2',
    title: 'OPERATIONAL',
    bar: '\u25B0\u25B0\u25B0\u25B0\u25B0\u25B0\u25B0\u25B0\u25B0\u25B0',
    description: 'All systems nominal'
  },
  offline: {
    color: 0xF04747,
    icon: '\uD83D\uDD34',
    title: 'OUTAGE',
    bar: '\u25B1\u25B1\u25B1\u25B1\u25B1\u25B1\u25B1\u25B1\u25B1\u25B1',
    description: 'Service disruption detected'
  },
  pending: {
    color: 0xFAA61A,
    icon: '\uD83D\uDFE1',
    title: 'PENDING',
    bar: '\u25B0\u25B0\u25B0\u25B1\u25B1\u25B1\u25B1\u25B1\u25B1\u25B1',
    description: 'Initializing checks'
  },
  maintenance: {
    color: 0x7289DA,
    icon: '\uD83D\uDD35',
    title: 'MAINTENANCE',
    bar: '\u25B0\u25B0\u25B0\u25B0\u25B0\u25B1\u25B1\u25B1\u25B1\u25B1',
    description: 'Planned maintenance ongoing'
  },
  deactivated: {
    color: 0x747F8D,
    icon: '\u26AB',
    title: 'DEACTIVATED',
    bar: '\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC',
    description: 'Service disabled'
  }
};
// #endregion

// #region 8. NOTIFICATION MANAGER
class NotificationManager {
  constructor() {
    this.lastStatus = new Map();
  }

  async checkForNotifications(monitor, statusCode) {
    const statusKey = statusCode === 1 ? 'up' : statusCode === 0 ? 'down' : 'unknown';
    if (this.lastStatus.has(monitor.id) && this.lastStatus.get(monitor.id) !== statusKey) {
      await this.sendNotification(monitor, statusKey);
    }
    this.lastStatus.set(monitor.id, statusKey);
  }

  async sendNotification(monitor, status) {
    try {
      const channelId = config.get('discord.notificationChannel');
      if (!channelId) return;
      const channel = await client.channels.fetch(channelId);
      const emoji = status === 'up' ? '\u2705' : '\uD83D\uDEA8';
      await channel.send(`${emoji} Status\u00e4nderung bei **${monitor.name}**: ${status.toUpperCase()}`);
    } catch (err) {
      logger.error(`Benachrichtigung fehlgeschlagen: ${err.message}`);
    }
  }
}
// #endregion

// #region 9. DISCORD CLIENT
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});
const notificationManager = new NotificationManager();
// #endregion

// #region 10. STATE PERSISTENZ
const STATE_FILE = './data/state.json';

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveState(state) {
  try {
    fs.mkdirSync('./data', { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logger.error(`State speichern fehlgeschlagen: ${err.message}`);
  }
}

const _initState           = loadState();
let statusMessageId        = _initState.statusMessageId    ?? null;
let lastChannelStatus      = _initState.lastChannelStatus  ?? null;
let lastChannelNameMs      = _initState.lastChannelNameMs  ?? 0;
let serviceCategoryId      = _initState.serviceCategoryId  ?? null;
let serviceChannels        = _initState.serviceChannels     ?? {};  // { monitorName: channelId }
const _svcRenameMs         = {};  // Rate-Limit pro Kanal (in-memory, wird nicht persistiert)
// #endregion

// #region 11. RATE-LIMIT SCHUTZ
let lastEditTimestamp = 0;
const MIN_EDIT_INTERVAL_MS  = 5_000;
const MIN_CHANNEL_RENAME_MS = 6 * 60 * 1000;  // 6 min sicherer Puffer (Discord: max 2/10min)
const STATUS_DOT = { green: '🟢', yellow: '🟡', red: '🔴' };
// #endregion

// #region 12. RETRY-LOGIK
async function withRetry(fn, retries = 3, baseDelayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      logger.warn(`Versuch ${attempt}/${retries} fehlgeschlagen, Retry in ${delay}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
// #endregion

// #region 13. UPTIME KUMA API HELPER
async function fetchUptimeKumaData(endpoint) {
  return withRetry(async () => {
    const uptimeKumaUrl = config.get('uptimeKuma.url');
    const apiKey = config.get('uptimeKuma.apiKey');
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const response = await axios.get(`${uptimeKumaUrl}${endpoint}`, { headers, timeout: 10_000 });
    return response.data;
  }).catch(err => {
    logger.error(`Uptime Kuma Fetch Error (alle Versuche fehlgeschlagen): ${err.message}`);
    return null;
  });
}
// #endregion

// #region 14. MONITOR-DATEN ABRUFEN
async function getMonitorData() {
  const slug = config.get('uptimeKuma.statusPageSlug');
  const [heartbeats, statusPage] = await Promise.all([
    fetchUptimeKumaData(`/api/status-page/heartbeat/${slug}`),
    fetchUptimeKumaData(`/api/status-page/${slug}`)
  ]);

  if (!heartbeats || !statusPage) return null;

  const monitorMap = new Map();
  statusPage.publicGroupList?.forEach(group => {
    group.monitorList?.forEach(monitor => {
      monitorMap.set(monitor.id.toString(), {
        name: monitor.name,
        group: group.name,
        active: monitor.active ?? true
      });
    });
  });

  return Object.entries(heartbeats.heartbeatList || {}).map(([id, beats]) => {
    if (!beats?.length) return null;
    const latest = beats[beats.length - 1];
    const info = monitorMap.get(id) || {};
    return {
      id,
      name: info.name || `Service ${id}`,
      group: info.group || 'General',
      status: latest.status,
      time: latest.time,
      ping: latest.ping,
      active: info.active,
      uptime: calculateUptime(beats)
    };
  }).filter(Boolean);
}

function calculateUptime(heartbeats) {
  const valid = heartbeats.filter(h => [0, 1].includes(h.status));
  const up = valid.filter(h => h.status === 1).length;
  return ((up / valid.length) * 100 || 0).toFixed(1);
}
// #endregion

// #region 15. EMBED-GENERIERUNG
function createServiceField(monitor) {
  const theme = monitor.status === 1 ? STATUS_THEME.online
              : monitor.status === 0 ? STATUS_THEME.offline
              : monitor.status === 2 ? STATUS_THEME.pending
              : STATUS_THEME.deactivated;
  const ping   = monitor.ping   != null ? `${monitor.ping}ms` : '–';
  const uptime = monitor.uptime != null ? `${monitor.uptime}%` : '–';
  return {
    name:   `${theme.icon} ${monitor.name}`,
    value:  `\`${theme.title}\`\n⏱ ${ping} · 📈 ${uptime}`,
    inline: true
  };
}
// #endregion

// #region 15b. ANSI-STATUS-NACHRICHT (Uptime-Kuma-Style)
function buildAnsiStatusMessage(monitors, statusPageUrl = null) {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('de-DE');
  const timeStr = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const active  = monitors.filter(m => m.active !== false);

  // Monitore nach Gruppe sortieren
  const groups = {};
  for (const m of active) {
    const g = m.group || 'General';
    if (!groups[g]) groups[g] = [];
    groups[g].push(m);
  }

  // ANSI-Farben
  const G = '\u001b[1;32m'; // grün
  const R = '\u001b[1;31m'; // rot
  const Y = '\u001b[1;33m'; // gelb (pending)
  const W = '\u001b[1;37m'; // weiß/hell
  const C = '\u001b[1;36m'; // cyan
  const X = '\u001b[0m';    // reset

  const lines = [];

  // Header-Zeile (wie Uptime Kuma)
  lines.push(`${C}⊞ DIENSTE STATUS-ÜBERSICHT${X}    Stand: ${dateStr}, ${timeStr}`);
  lines.push('');

  for (const [groupName, groupMonitors] of Object.entries(groups)) {
    lines.push(`${W}${groupName} [${groupMonitors.length}]${X}`);

    for (const m of groupMonitors) {
      const isUp      = m.status === 1;
      const isPending = m.status === 2;
      const col       = isUp ? G : isPending ? Y : R;

      // Fortschrittsbalken (16 Zeichen, wie Uptime Kuma)
      const barWidth = 16;
      const pct      = parseFloat(m.uptime) || 0;
      const filled   = Math.round((pct / 100) * barWidth);
      const bar      = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

      // Status-Label (einheitliche Breite)
      const statusLabel = (isUp ? 'OPERATIONAL' : isPending ? 'PENDING    ' : 'OUTAGE     ');

      // Zeitstempel des letzten Heartbeats
      const lastTime = m.time
        ? new Date(m.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : '--:--:--';

      // Name auf 22 Zeichen begrenzen/auffüllen
      const name   = m.name.slice(0, 22).padEnd(22);
      const uptime = `${pct.toFixed(1)}%`.padStart(6);

      lines.push(`${col}●${X} ${name}  ${col}${statusLabel}${X}  ${col}${bar}${X}  ${uptime}  ${lastTime}`);
    }
    lines.push('');
  }

  // Letzte Leerzeile entfernen
  if (lines[lines.length - 1] === '') lines.pop();

  const ansiBlock = '```ansi\n' + lines.join('\n') + '\n```';

  // Kopfzeile mit optionalem Statusseiten-Link
  const header = statusPageUrl
    ? `🌐 **LIVE SERVICE STATUS** | [Statusseite öffnen](${statusPageUrl})`
    : '🌐 **LIVE SERVICE STATUS**';

  const footer = '*Uptime Kuma Status · Automatisch generiert*';

  const fullMessage = `${header}\n${ansiBlock}\n${footer}`;

  // Discord-Limit: 2000 Zeichen
  if (fullMessage.length > 1990) {
    logger.warn(`ANSI-Nachricht zu lang (${fullMessage.length} Zeichen) – wird gekürzt`);
    return `${header}\n` +
      '```ansi\n\u001b[1;31m⚠ Zu viele Dienste für eine Nachricht\u001b[0m\n```\n' +
      footer;
  }

  return fullMessage;
}
// #endregion

// #region 15c. CLOUDFLARE-URL FÜR STATUS-SEITE
function getPublicStatusUrl() {
  const cloudflareUrl = config.get('cloudflare.publicUrl');
  const slug          = config.get('uptimeKuma.statusPageSlug');
  if (!cloudflareUrl) return null;
  return `${cloudflareUrl.replace(/\/+$/, '')}/status/${slug}`;
}

function getWebUrl() {
  // Liefert die öffentliche URL zum Bot-Webserver (für API-Endpoints wie /api/status-unfurl)
  const webPublicUrl = config.get('webPublicUrl');
  if (webPublicUrl) return webPublicUrl.replace(/\/+$/, '');
  return null;
}

async function isStatusPageReachable(url) {
  if (!url) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;

  try {
    const headResp = await axios.head(url, {
      timeout: 8_000,
      maxRedirects: 5,
      validateStatus: () => true
    });
    if (headResp.status >= 200 && headResp.status < 400) return true;
  } catch {
    // Manche Setups blockieren HEAD, deshalb danach GET probieren.
  }

  try {
    const getResp = await axios.get(url, {
      timeout: 8_000,
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: 'text'
    });
    return getResp.status >= 200 && getResp.status < 400;
  } catch {
    return false;
  }
}

function readMetaTag(html, attribute, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<meta[^>]+${attribute}=["']${escapedName}["'][^>]+content=["']([^"']*)["'][^>]*>|<meta[^>]+content=["']([^"']*)["'][^>]+${attribute}=["']${escapedName}["'][^>]*>`,
    'i'
  );
  const match = html.match(pattern);
  return (match?.[1] || match?.[2] || '').trim();
}

async function inspectStatusPagePreview(url) {
  if (!url) {
    return { reachable: false, richPreview: false };
  }

  try {
    const resp = await axios.get(url, {
      timeout: 8_000,
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: 'text'
    });

    if (resp.status < 200 || resp.status >= 400 || typeof resp.data !== 'string') {
      return { reachable: false, richPreview: false };
    }

    const html = resp.data;
    const ogTitle = readMetaTag(html, 'property', 'og:title');
    const ogDescription = readMetaTag(html, 'property', 'og:description');
    const ogImage = readMetaTag(html, 'property', 'og:image');
    const twitterCard = readMetaTag(html, 'name', 'twitter:card');
    const twitterImage = readMetaTag(html, 'name', 'twitter:image');
    const metaDescription = readMetaTag(html, 'name', 'description');

    const richPreview = Boolean(
      ogImage ||
      twitterImage ||
      (twitterCard && twitterCard !== 'summary') ||
      ogDescription ||
      metaDescription
    );

    return {
      reachable: true,
      richPreview,
      meta: {
        ogTitle,
        ogDescription,
        ogImage,
        twitterCard,
        twitterImage,
        metaDescription
      }
    };
  } catch {
    return { reachable: false, richPreview: false };
  }
}

async function getStatusRenderMode() {
  const configuredMode = config.get('discord.statusRenderMode');
  const publicStatusUrl = getPublicStatusUrl();
  const webUrl = getWebUrl ? getWebUrl() : null;

  if (configuredMode === 'embed') {
    return { mode: 'custom_embed', publicStatusUrl };
  }

  if (!publicStatusUrl) {
    return { mode: 'custom_embed', publicStatusUrl: null };
  }

  // "direct" Mode: Proxy mit injiziertem OG-Tags
  if (configuredMode === 'direct') {
    const reachable = await isStatusPageReachable(publicStatusUrl);
    if (reachable && webUrl) {
      return { mode: 'direct', proxyUrl: `${webUrl}/api/status-unfurl` };
    }
    if (!webUrl) {
      logger.warn('Status Render Mode: direct erzwungen, aber WEB_PUBLIC_URL ist nicht gesetzt - Proxy-Link kann nicht gebaut werden');
    }
    logger.warn(`Status Render Mode: direct erzwungen, aber nicht erreichbar - Fallback auf embed`);
    return { mode: 'custom_embed', publicStatusUrl };
  }

  // "graphical" Mode: Link mit Badge-Bild
  if (configuredMode === 'graphical') {
    const reachable = await isStatusPageReachable(publicStatusUrl);
    if (reachable && webUrl) {
      return { mode: 'graphical', proxyUrl: `${webUrl}/api/status-unfurl?variant=graphical` };
    }
    if (!webUrl) {
      logger.warn('Status Render Mode: graphical erzwungen, aber WEB_PUBLIC_URL ist nicht gesetzt - Proxy-Link kann nicht gebaut werden');
    }
    logger.warn(`Status Render Mode: graphical erzwungen, aber nicht erreichbar - Fallback auf embed`);
    return { mode: 'custom_embed', publicStatusUrl };
  }

  // Legacy-Modus für bestehende .env-Dateien
  if (configuredMode === 'link_preview') {
    const reachable = await isStatusPageReachable(publicStatusUrl);
    if (!reachable) {
      logger.warn(`Status Render Mode: link_preview (legacy) - Statusseite nicht erreichbar, Fallback auf embed: ${publicStatusUrl}`);
      return { mode: 'custom_embed', publicStatusUrl };
    }

    // Wichtig: Legacy-Wert link_preview wird auf den neuen Unfurl-Proxy gemappt,
    // damit OG:description und OG:image zuverlässig gesetzt sind.
    if (webUrl) {
      return { mode: 'direct', proxyUrl: `${webUrl}/api/status-unfurl?legacy=1`, publicStatusUrl };
    }

    return { mode: 'link_preview', publicStatusUrl };
  }

  // "auto" Mode: Beste Methode wählen (direct → graphical → embed)
  const reachable = await isStatusPageReachable(publicStatusUrl);
  if (!reachable) {
    logger.warn(`Status Render Mode: auto - Statusseite nicht erreichbar, Fallback auf embed: ${publicStatusUrl}`);
    return { mode: 'custom_embed', publicStatusUrl };
  }

  // Versuche direct mode wenn web-server verfügbar
  if (webUrl) {
    return { mode: 'direct', proxyUrl: `${webUrl}/api/status-unfurl` };
  }

  logger.warn('Status Render Mode: auto - WEB_PUBLIC_URL fehlt, deshalb nur direkter Statusseiten-Link ohne OG-Proxy möglich');

  // Fallback ohne öffentliche Web-URL: klassisches Link-Preview direkt auf Statusseite
  return { mode: 'link_preview', publicStatusUrl };
}

function buildStatusDirectMessage(proxyUrl) {
  if (!proxyUrl) return '';
  try {
    const url = new URL(proxyUrl);
    const cacheBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    url.searchParams.set('discord_unfurl', String(cacheBucket));
    return url.toString();
  } catch {
    return proxyUrl;
  }
}

function buildStatusGraphicalMessage(statusUrl, badgeUrl) {
  if (!statusUrl) return '';
  try {
    const url = new URL(statusUrl);
    const cacheBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    url.searchParams.set('discord_unfurl', String(cacheBucket));
    if (badgeUrl) url.searchParams.set('badge', badgeUrl);
    return url.toString();
  } catch {
    return statusUrl;
  }
}

function buildStatusLinkPreviewMessage(statusPageUrl) {
  if (!statusPageUrl) return '';

  // Discord cached Link-Unfurls teilweise sehr aggressiv.
  // Ein zeitbasierter Query-Parameter (5-Minuten-Bucket) erzwingt einen frischen Fetch,
  // ohne bei jedem Poll eine komplett neue URL zu erzeugen.
  try {
    const url = new URL(statusPageUrl);
    const cacheBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    url.searchParams.set('discord_unfurl', String(cacheBucket));
    return url.toString();
  } catch {
    return statusPageUrl;
  }
}
// #endregion

// #region 15d. STATUS-EMBED (Discord-Karte mit ANSI-Block)
function buildStatusEmbed(monitors, statusPageUrl = null) {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('de-DE');
  const timeStr = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const active = monitors.filter(m => m.active !== false);

  const groups = {};
  for (const m of active) {
    const g = m.group || 'General';
    if (!groups[g]) groups[g] = [];
    groups[g].push(m);
  }

  const anyDown    = active.some(m => m.status === 0);
  const anyPending = active.some(m => m.status === 2);
  const embedColor = anyDown ? 0xF04747 : anyPending ? 0xFAA61A : 0x43B581;

  const G = '\u001b[1;32m';
  const R = '\u001b[1;31m';
  const Y = '\u001b[1;33m';
  const W = '\u001b[1;37m';
  const S = '\u001b[0;90m';
  const BG_CARD = '\u001b[40m';
  const BG_SECTION = '\u001b[100m';
  const BG_BAR_ON = '\u001b[42m';
  const BG_BAR_OFF = '\u001b[41m';
  const BG_BAR_PENDING = '\u001b[43m';
  const BG_BAR_TRACK = '\u001b[100m';
  const X = '\u001b[0m';

  const headerWidth = 74;
  const nameWidth = 20;
  const statusWidth = 11;
  const barUnits = 14;
  const footerText = ' Uptime Kuma Status - automatisch generiert';

  const makeHeaderLine = (left, right = '') => {
    const padding = Math.max(2, headerWidth - left.length - right.length);
    return `${BG_CARD}${W} ${left}${' '.repeat(padding)}${right ? `${S}${right}` : ''}${X}`;
  };

  const makeSectionLine = (label) => {
    const content = `## ${label}`;
    const padding = Math.max(1, headerWidth - content.length);
    return `${BG_SECTION}${W} ${content}${' '.repeat(padding)}${X}`;
  };

  const makeSpacerLine = () => `${BG_CARD}${' '.repeat(headerWidth + 1)}${X}`;

  const buildBar = (pct, status) => {
    const clamped = Math.max(0, Math.min(100, pct));
    const fillColor = status === 1 ? BG_BAR_ON : status === 2 ? BG_BAR_PENDING : BG_BAR_OFF;
    const filled = clamped <= 0 ? 1 : Math.max(1, Math.round((clamped / 100) * barUnits));
    const safeFilled = Math.min(barUnits, filled);
    const empty = Math.max(0, barUnits - safeFilled);
    return `${fillColor}${' '.repeat(safeFilled * 2)}${BG_BAR_TRACK}${' '.repeat(empty * 2)}`;
  };

  const padCardLine = (content, visibleLength) => {
    const padding = Math.max(1, headerWidth - visibleLength);
    return `${BG_CARD}${content}${' '.repeat(padding)}${X}`;
  };

  const lines = [];
  lines.push(makeHeaderLine('[] DIENSTE STATUS-UEBERSICHT', `Stand: ${dateStr}, ${timeStr}`));
  lines.push(makeSpacerLine());

  for (const [groupName, groupMonitors] of Object.entries(groups)) {
    lines.push(makeSectionLine(`${groupName.toUpperCase()} [${groupMonitors.length}]`));

    for (const m of groupMonitors) {
      const isUp = m.status === 1;
      const isPending = m.status === 2;
      const col = isUp ? G : isPending ? Y : R;
      const pct = parseFloat(m.uptime) || 0;
      const statusLabel = (isUp ? 'OPERATIONAL' : isPending ? 'PENDING' : 'OUTAGE').padEnd(statusWidth);
      const name = m.name.slice(0, nameWidth).padEnd(nameWidth);
      const uptime = `${pct.toFixed(1)}%`.padStart(6);
      const lastTime = m.time
        ? new Date(m.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : '--:--:--';
      const bar = buildBar(pct, m.status);

      const visibleLength = 1 + 2 + nameWidth + 2 + statusWidth + 2 + (barUnits * 2) + 2 + uptime.length + 1 + lastTime.length;
      const content = ` ${col}\u25CF${W} ${name}  ${col}${statusLabel}${W}  ${bar}${BG_CARD}${W}  ${uptime} ${S}${lastTime}`;
      lines.push(padCardLine(content, visibleLength));
    }

    lines.push(makeSpacerLine());
  }

  lines.push(`${BG_CARD}${S}${footerText}${' '.repeat(Math.max(1, headerWidth - footerText.length))}${X}`);

  const ansiBlock = '```ansi\n' + lines.join('\n') + '\n```';

  const title = statusPageUrl
    ? '\uD83C\uDF10 LIVE SERVICE STATUS | Statusseite oeffnen'
    : '\uD83C\uDF10 LIVE SERVICE STATUS';

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle(title)
    .setFooter({ text: 'Uptime Kuma' });

  if (statusPageUrl) embed.setURL(statusPageUrl);

  if (ansiBlock.length > 4000) {
    logger.warn(`Status-Embed: Inhalt zu lang (${ansiBlock.length} Zeichen) - wird gekuerzt`);
    embed.setDescription('```ansi\n\u001b[1;31m[!] Zu viele Dienste fuer eine Nachricht\u001b[0m\n```');
  } else {
    embed.setDescription(ansiBlock);
  }

  return embed;
}
// #endregion

// #region 16. CHANNEL-INDIKATOR (Name + Topic)
function _overallStatus(monitors) {
  const active = monitors.filter(m => m.active !== false);
  if (!active.length) return 'green';
  const anyDown    = active.some(m => m.status === 0);
  const anyPending = active.some(m => m.status === 2);
  if (anyDown)    return 'red';
  if (anyPending) return 'yellow';
  return 'green';
}

async function updateChannelIndicator(channel, monitors) {
  if (!config.get('discord.channelStatusIndicator')) return;

  const status = _overallStatus(monitors);
  if (status === lastChannelStatus) return;   // kein Wechsel → kein API-Call

  const now = Date.now();
  if (now - lastChannelNameMs < MIN_CHANNEL_RENAME_MS) {
    const remaining = Math.ceil((MIN_CHANNEL_RENAME_MS - (now - lastChannelNameMs)) / 1000);
    logger.warn(`Channel-Indikator: Status → ${status}, Rate-Limit-Cooldown (noch ${remaining}s)`);
    return;
  }

  // Basis-Name: vorhandene Status-Emoji am Anfang entfernen
  const baseName = channel.name.replace(/^[🟢🟡🔴]+/u, '').trim();
  const dot      = STATUS_DOT[status];
  const newName  = `${dot}${baseName}`;

  // Topic-Zusammenfassung
  const active   = monitors.filter(m => m.active !== false);
  const online   = active.filter(m => m.status === 1).length;
  const offline  = active.filter(m => m.status === 0).length;
  const timeStr  = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const newTopic = `${dot} ${online}/${active.length} Dienste online`
    + (offline > 0 ? ` · ${offline} offline` : '')
    + ` · Stand: ${timeStr}`;

  try {
    await channel.edit({ name: newName, topic: newTopic });
    lastChannelStatus = status;
    lastChannelNameMs = now;
    saveState({ statusMessageId, lastChannelStatus, lastChannelNameMs, serviceCategoryId, serviceChannels });
    logger.info(`Channel-Indikator: ${channel.name} → ${newName} | ${newTopic}`);
  } catch (err) {
    logger.error(`Channel-Indikator fehlgeschlagen: ${err.message}`);
  }
}
// #endregion

// #region 16b. DISCORD STATUS-NACHRICHT
async function updateStatusMessage() {
  const now = Date.now();
  if (now - lastEditTimestamp < MIN_EDIT_INTERVAL_MS) {
    logger.warn('Rate-Limit-Schutz: Update übersprungen (zu schnell aufgerufen)');
    return;
  }

  const channelId = config.get('discord.statusChannelId');
  let channel = client.channels.cache.get(channelId);
  if (!channel && channelId) {
    try {
      channel = await client.channels.fetch(channelId);
    } catch (err) {
      logger.error(`discord.statusChannelId konnte nicht geladen werden (${channelId}): ${err.message}`);
    }
  }
  if (!channel) {
    logger.error(`Ung\u00fcltige discord.statusChannelId \u2013 Channel nicht gefunden (${channelId || 'leer'})`);
    return;
  }

  const monitors = await getMonitorData();
  if (!monitors?.length) {
    logger.warn('Keine Monitore von Uptime Kuma erhalten');
    return;
  }

  let operationalCount = 0;
  for (const monitor of monitors) {
    try {
      const statusStr = monitor.status === 1 ? 'up' : monitor.status === 0 ? 'down' : 'unknown';
      await MonitorStatus.create({
        monitorId: parseInt(monitor.id),
        status: statusStr,
        responseTime: monitor.ping || null
      });
      await notificationManager.checkForNotifications(monitor, monitor.status);
      if (monitor.status === 1) operationalCount++;
    } catch (err) {
      logger.error(`DB-Fehler bei Monitor ${monitor.id}: ${err.message}`);
    }
  }

  const uptimePercent = (operationalCount / monitors.length) * 100;
  uptimeGauge.set(uptimePercent);
  statusCheckCounter.inc();

  // ── Nachricht: Multi-Mode Support (direct / graphical / link_preview / embed) ────
  const renderDecision = await getStatusRenderMode();
  const statusEmbed = buildStatusEmbed(monitors, renderDecision.publicStatusUrl);
  
  let messagePayload = { content: null, embeds: [statusEmbed] };
  
  if (renderDecision.mode === 'direct') {
    messagePayload = { content: buildStatusDirectMessage(renderDecision.proxyUrl), embeds: [] };
  } else if (renderDecision.mode === 'graphical') {
    messagePayload = { content: buildStatusDirectMessage(renderDecision.proxyUrl), embeds: [] };
  } else if (renderDecision.mode === 'link_preview') {
    messagePayload = { content: buildStatusLinkPreviewMessage(renderDecision.publicStatusUrl), embeds: [] };
  }

  try {
    if (statusMessageId) {
      try {
        const existingMessage = await channel.messages.fetch(statusMessageId);
        // Für Link-Preview Modi: Lösche alte Message und sende neu (Discord unfurlt nur neue Messages)
        if (['direct', 'graphical', 'link_preview'].includes(renderDecision.mode)) {
          await existingMessage.delete();
          const newMessage = await channel.send(messagePayload);
          statusMessageId = newMessage.id;
          saveState({ statusMessageId, lastChannelStatus, lastChannelNameMs, serviceCategoryId, serviceChannels });
        } else {
          // Für Embeds: Normal editieren
          await existingMessage.edit(messagePayload);
        }
      } catch {
        const newMessage = await channel.send(messagePayload);
        statusMessageId = newMessage.id;
        saveState({ statusMessageId, lastChannelStatus, lastChannelNameMs, serviceCategoryId, serviceChannels });
      }
    } else {
      const newMessage = await channel.send(messagePayload);
      statusMessageId = newMessage.id;
      saveState({ statusMessageId, lastChannelStatus, lastChannelNameMs, serviceCategoryId, serviceChannels });
    }
    lastEditTimestamp = Date.now();
    logger.info(`Status aktualisiert: ${operationalCount}/${monitors.length} Dienste online`);
    logger.info(`Status Render Mode: ${renderDecision.mode}${renderDecision.publicStatusUrl ? ` | ${renderDecision.publicStatusUrl}` : renderDecision.proxyUrl ? ` | proxy` : ``}`);
    if (messagePayload?.content) {
      logger.info(`Status Link gesendet: ${messagePayload.content}`);
    }

    // Channel-Name + Topic bei Statuswechsel aktualisieren
    await updateChannelIndicator(channel, monitors);
    // Service-Kanäle in der Kanalleiste aktualisieren
    await syncServiceChannels(monitors);
  } catch (error) {
    logger.error(`Discord-Nachrichtenfehler: ${error.message}`);
    statusMessageId = null;
  }
}
// #endregion

// #region 17. SERVICE-KANAL-MANAGER
/**
 * Erstellt automatisch eine Discord-Kategorie + je einen Textkanal pro
 * überwachtem Dienst. Der Kanalname zeigt per Emoji den Live-Status:
 *   🟢-nginx    → online
 *   🔴-database → offline
 *   🟡-api      → ausstehend
 *
 * Konfiguration via .env:
 *   GUILD_ID              – Guild-ID des Servers (Pflicht für dieses Feature)
 *   SERVICE_CATEGORY_NAME – Kategoriename (Standard: "📊 Service Status")
 *   MONITORED_SERVICES    – kommagetrennte Whitelist, z.B. "nginx,database,api"
 *                           (leer = alle aktiven Dienste)
 *
 * Discord Rate-Limit: max. 2 Umbenennungen pro Kanal / 10 Minuten.
 * Der Cooldown von 6 Minuten (MIN_CHANNEL_RENAME_MS) wird auch hier eingehalten.
 */
function _serviceChannelName(monitorName, status) {
  const dot  = status === 1 ? '🟢' : status === 0 ? '🔴' : '🟡';
  const slug = monitorName
    .toLowerCase()
    .replace(/[äöüß]/g, c => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 94);
  return `${dot}-${slug}`;
}

async function syncServiceChannels(monitors) {
  const guildId = config.get('discord.guildId');
  if (!guildId) return;  // Feature nicht konfiguriert

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    logger.warn(`Service-Kanal-Manager: Guild "${guildId}" nicht im Cache – Bot auf dem Server?`);
    return;
  }

  // Whitelist filtern (oder alle aktiven Dienste wenn leer)
  const whitelist = (config.get('discord.monitoredServices') || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  if (!whitelist.length) {
    logger.warn('Service-Kanal-Manager: MONITORED_SERVICES ist leer – Feature deaktiviert. Bitte konkrete Dienste in .env eintragen.');
    return;
  }

  const targets = monitors.filter(m => whitelist.includes(m.name.toLowerCase()));

  if (!targets.length) return;

  // ── Kategorie sicherstellen ───────────────────────────────────────────────
  let category = serviceCategoryId ? guild.channels.cache.get(serviceCategoryId) : null;
  if (!category) {
    const catName = config.get('discord.serviceCategoryName');
    category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === catName
    );
    if (!category) {
      try {
        category = await guild.channels.create({
          name: catName,
          type: ChannelType.GuildCategory,
          permissionOverwrites: [
            { id: guild.roles.everyone, deny: [PermissionFlagsBits.SendMessages] }
          ]
        });
        logger.info(`Service-Kanal-Manager: Kategorie "${catName}" erstellt (ID: ${category.id})`);
      } catch (err) {
        logger.error(`Service-Kanal-Manager: Kategorie erstellen fehlgeschlagen: ${err.message}`);
        return;
      }
    }
    serviceCategoryId = category.id;
    saveState({ statusMessageId, lastChannelStatus, lastChannelNameMs, serviceCategoryId, serviceChannels });
  }

  // ── Kanäle erstellen / umbenennen ─────────────────────────────────────────
  const now = Date.now();
  let stateChanged = false;

  for (const monitor of targets) {
    const desiredName = _serviceChannelName(monitor.name, monitor.status);
    const topic       = `📈 Uptime: ${monitor.uptime ?? '–'}%  ⏱ Ping: ${monitor.ping != null ? monitor.ping + 'ms' : '–'}`;
    let channelId     = serviceChannels[monitor.name];
    let channel       = channelId ? guild.channels.cache.get(channelId) : null;

    // Kanal existiert nicht → erstellen
    if (!channel) {
      try {
        channel = await guild.channels.create({
          name:   desiredName,
          type:   ChannelType.GuildText,
          parent: category.id,
          topic,
          permissionOverwrites: [
            { id: guild.roles.everyone, deny: [PermissionFlagsBits.SendMessages] }
          ]
        });
        serviceChannels[monitor.name] = channel.id;
        stateChanged = true;
        logger.info(`Service-Kanal-Manager: Kanal "${desiredName}" erstellt`);
      } catch (err) {
        logger.error(`Service-Kanal-Manager: Kanal für "${monitor.name}" fehlgeschlagen: ${err.message}`);
        continue;
      }
    }

    // Kanal umbenennen wenn Status sich geändert hat
    if (channel.name !== desiredName) {
      const lastRename = _svcRenameMs[channel.id] ?? 0;
      if (now - lastRename < MIN_CHANNEL_RENAME_MS) {
        const cooldown = Math.ceil((MIN_CHANNEL_RENAME_MS - (now - lastRename)) / 1000);
        logger.warn(`Service-Kanal-Manager: "${monitor.name}" wartet noch ${cooldown}s (Rate-Limit)`);
        continue;
      }
      try {
        await channel.edit({ name: desiredName, topic });
        _svcRenameMs[channel.id] = now;
        logger.info(`Service-Kanal-Manager: "${channel.name}" → "${desiredName}"`);
      } catch (err) {
        logger.error(`Service-Kanal-Manager: Umbenennen "${monitor.name}" fehlgeschlagen: ${err.message}`);
      }
    }
  }

  if (stateChanged) {
    saveState({ statusMessageId, lastChannelStatus, lastChannelNameMs, serviceCategoryId, serviceChannels });
  }
}
// #endregion

// #region 18. DB-CLEANUP
async function cleanupOldEntries() {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const deleted = await MonitorStatus.destroy({ where: { createdAt: { [Op.lt]: cutoff } } });
    if (deleted > 0) logger.info(`DB-Cleanup: ${deleted} alte Eintr\u00e4ge gel\u00f6scht (older than 30 days)`);
  } catch (err) {
    logger.error(`DB-Cleanup fehlgeschlagen: ${err.message}`);
  }
}
// #endregion

// #region 19. UPTIME-BERECHNUNG
async function calculateUptimeMetrics() {
  const total = await MonitorStatus.count();
  if (total === 0) return '0.00';
  const up = await MonitorStatus.count({ where: { status: 'up' } });
  return ((up / total) * 100).toFixed(2);
}
// #endregion

// #region 20. SLASH-COMMANDS REGISTRIEREN
async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Zeigt den aktuellen Status aller Services')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('uptime')
      .setDescription('Zeigt die Gesamt-Uptime aller aufgezeichneten Checks')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('refresh')
      .setDescription('Erzwingt einen sofortigen Status-Refresh (nur Admins)')
      .toJSON()
  ];

  try {
    const rest = new REST({ version: '10' }).setToken(config.get('discord.token'));
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    logger.info('Slash-Commands erfolgreich registriert');
  } catch (err) {
    logger.error(`Slash-Command-Registrierung fehlgeschlagen: ${err.message}`);
  }
}
// #endregion

// #region 21. SLASH-COMMAND HANDLER
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'status') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const monitors = await getMonitorData();
      if (!monitors?.length) {
        return interaction.editReply('\u274C Keine Daten von Uptime Kuma erhalten.');
      }
      const online = monitors.filter(m => m.status === 1).length;
      const offline = monitors.filter(m => m.status === 0).length;
      const total = monitors.length;
      const lines = monitors.map(m => {
        const icon = m.status === 1 ? '\uD83D\uDFE2' : m.status === 0 ? '\uD83D\uDD34' : '\uD83D\uDFE1';
        return `${icon} **${m.name}** \u2014 ${m.uptime}% Uptime`;
      });
      await interaction.editReply({
        embeds: [{
          color: online === total ? 0x43B581 : offline > 0 ? 0xF04747 : 0xFAA61A,
          title: '\uD83D\uDCCA Service Status',
          description: lines.join('\n'),
          footer: { text: `${online}/${total} Dienste online` },
          timestamp: new Date().toISOString()
        }]
      });
    } catch (err) {
      logger.error(`/status Fehler: ${err.message}`);
      await interaction.editReply('\u274C Fehler beim Abrufen der Daten.');
    }
  }

  if (interaction.commandName === 'uptime') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const uptime = await calculateUptimeMetrics();
      await interaction.editReply({
        embeds: [{
          color: 0x43B581,
          title: '\uD83D\uDCC8 Gesamt-Uptime',
          description: `**${uptime}%** aller aufgezeichneten Checks waren erfolgreich.`,
          timestamp: new Date().toISOString()
        }]
      });
    } catch (err) {
      logger.error(`/uptime Fehler: ${err.message}`);
      await interaction.editReply('\u274C Fehler beim Abrufen der Uptime.');
    }
  }

  if (interaction.commandName === 'refresh') {
    if (!interaction.memberPermissions?.has('ManageGuild')) {
      return interaction.reply({ content: '\u274C Keine Berechtigung (ManageGuild erforderlich).', ephemeral: true });
    }
    await interaction.reply({ content: '\uD83D\uDD04 Starte manuellen Refresh...', ephemeral: true });
    await updateStatusMessage();
    await interaction.editReply('\u2705 Status-Nachricht wurde aktualisiert.');
  }
});
// #endregion

// #region 22. UPDATE-ZYKLUS
function initializeUpdateCycle() {
  const interval = config.get('checkIntervalMs');
  logger.info(`Update-Zyklus gestartet (alle ${interval / 1000}s)`);
  updateStatusMessage();
  setInterval(updateStatusMessage, interval);
  // DB-Cleanup einmal täglich ausführen
  cleanupOldEntries();
  setInterval(cleanupOldEntries, 24 * 60 * 60 * 1000);
}
// #endregion

// #region 23. STARTUP
// Webserver SOFORT starten — unabhängig vom Discord-Login
// Damit ist das Dashboard auch erreichbar wenn der Token noch nicht stimmt
const _webDeps = { config, logger, client, sequelize, prom, getMonitorData, updateStatusMessage, rootDir: __dirname };
let _httpServer = null;
initializeDatabase().then(() => { _httpServer = startWebServer(_webDeps); }).catch(err => {
  logger.error(`DB/Webserver-Startfehler: ${err.message}`);
  _httpServer = startWebServer(_webDeps); // Webserver trotzdem starten (ohne DB)
});

client.once('ready', async () => {
  logger.info(`Bot eingeloggt als ${client.user.tag}`);
  client.user.setActivity('Service Health', { type: ActivityType.Watching });
  await registerSlashCommands();
  initializeUpdateCycle();
});

client.on('error', (err) => {
  logger.error(`Discord Client Fehler: ${err.message}`);
});

// Discord-Login (Fehler werden geloggt, Webserver läuft weiter)
client.login(config.get('discord.token')).catch(err => {
  logger.error(`Discord Login fehlgeschlagen: ${err.message}`);
  logger.warn('Bot läuft im eingeschränkten Modus — Dashboard unter http://localhost:' + config.get('webPort'));
});

async function initializeDatabase() {
  // sync() = create-if-not-exists, kein ALTER — SQLite unterstützt kein ALTER COLUMN
  await sequelize.sync();
  logger.info('Datenbank initialisiert');
}
// #endregion

// #region 24. TEST-INTEGRATION
if (process.env.NODE_ENV === 'test') {
  const testSuite = {
    async initialize() {
      await sequelize.sync();
    },
    async checkDatabase() {
      try {
        await sequelize.authenticate();
        return true;
      } catch {
        return false;
      }
    },
    async simulateStatusCheck() {
      const monitors = await getMonitorData();
      return { checksPerformed: monitors?.length ?? 0 };
    }
  };
  module.exports = { client, sequelize, testSuite };
}
// #endregion

// #region 25. GRACEFUL SHUTDOWN
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
  logger.info('Starte Shutdown...');
  if (_httpServer) _httpServer.close(() => logger.info('HTTP-Server geschlossen'));
  await sequelize.close();
  client.destroy();
  process.exit(0);
}
// #endregion
