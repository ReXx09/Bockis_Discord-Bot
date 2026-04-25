/**
 * Bockis Discord Bot
 * Copyright (c) 2026 ReXx09 (https://github.com/ReXx09)
 *
 * This software is licensed under the MIT License.
 * See the LICENSE file in the project root for full license details.
 *
 * SPDX-License-Identifier: MIT
 */

const { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const winston = require('winston');
require('winston-daily-rotate-file');
const prom = require('prom-client');
const { Sequelize, DataTypes, Op } = require('sequelize');
const fs = require('fs');
const { execFile } = require('child_process');

// #region 1. ENV-VALIDIERUNG
const path = require('path');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  console.error('[FATAL] Keine .env gefunden.');
  console.error('\nSo behebst du das:');
  console.error('  1. Kopiere .env.example zu .env');
  console.error('     PowerShell: Copy-Item .env.example .env');
  console.error('  2. Fuelle die Werte in .env aus und starte den Bot neu');
  process.exit(1);
}

const REQUIRED_ENV = ['DISCORD_TOKEN', 'STATUS_CHANNEL_ID', 'UPTIME_KUMA_URL'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error(`[FATAL] Fehlende Umgebungsvariablen: ${missingEnv.join(', ')}`);
  console.error('\nSo behebst du das:');
  console.error('  1. Kopiere .env.example zu .env und fuelle die Werte aus');
  console.error('     PowerShell: Copy-Item .env.example .env');
  console.error('  2. Starte den Bot nach dem Speichern neu');
  process.exit(1);
}
// #endregion

// #region 2. LOGGER MIT LOG-ROTATION
const LOG_TIMEZONE = process.env.LOG_TIMEZONE || process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const LOG_TS_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: LOG_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

function formatLogTimestamp() {
  const now = new Date();
  const base = LOG_TS_FORMATTER.format(now).replace(',', '');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${base}.${ms} ${LOG_TIMEZONE}`;
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: formatLogTimestamp }),
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
const pkg = require('./package.json');
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
      const mentions = getSubscriptionMentions(monitor);
      await channel.send({
        content: `${emoji} Status\u00e4nderung bei **${monitor.name}**: ${status.toUpperCase()}${mentions ? `\n${mentions}` : ''}`,
        allowedMentions: { users: mentions ? Array.from(new Set((userSubscriptions[String(monitor?.id || '')] || []))) : [] }
      });
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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
const notificationManager = new NotificationManager();
// #endregion

// #region 10. STATE PERSISTENZ
const STATE_FILE = path.join(__dirname, 'data', 'state.json');

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
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logger.error(`State speichern fehlgeschlagen: ${err.message}`);
  }
}

const _initState           = loadState();
let statusMessageId        = _initState.statusMessageId    ?? null;
let webhookStatusMessageId = _initState.webhookStatusMessageId ?? null;
let lastChannelStatus      = _initState.lastChannelStatus  ?? null;
let lastChannelNameMs      = _initState.lastChannelNameMs  ?? 0;
let serviceCategoryId      = _initState.serviceCategoryId  ?? null;
let serviceChannels        = _initState.serviceChannels     ?? {};  // { monitorName: channelId }
let userSubscriptions      = _initState.userSubscriptions   ?? {};  // { monitorId: [userId, ...] }
let savedQuotes            = Array.isArray(_initState.quotes) ? _initState.quotes : [];
let pendingReminders       = Array.isArray(_initState.reminders) ? _initState.reminders : [];
const _svcRenameMs         = _initState.svcRenameMs         ?? {};  // Rate-Limit-Zeitstempel pro Kanal-ID
const _reminderTimers      = new Map();

function persistState() {
  saveState({
    statusMessageId,
    webhookStatusMessageId,
    lastChannelStatus,
    lastChannelNameMs,
    serviceCategoryId,
    serviceChannels,
    userSubscriptions,
    quotes: savedQuotes,
    reminders: pendingReminders,
    svcRenameMs: _svcRenameMs
  });
}

function formatDurationShort(ms) {
  const totalSeconds = Math.max(1, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!parts.length || (!days && !hours && seconds)) parts.push(`${seconds}s`);
  return parts.slice(0, 3).join(' ');
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function parseDurationInput(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return null;
  const match = raw.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/i);
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = match[2] || 'm';
  if (/^(m|min|mins|minute|minutes)$/i.test(unit)) return amount * 60 * 1000;
  if (/^(h|hr|hrs|hour|hours)$/i.test(unit)) return amount * 60 * 60 * 1000;
  if (/^(d|day|days)$/i.test(unit)) return amount * 24 * 60 * 60 * 1000;
  if (/^(w|week|weeks)$/i.test(unit)) return amount * 7 * 24 * 60 * 60 * 1000;
  return null;
}

function resolveMonitorByQuery(monitors, query) {
  const raw = String(query || '').trim();
  if (!raw) return null;
  const needle = raw.toLowerCase();
  return monitors.find(m => String(m.id) === raw)
    || monitors.find(m => String(m.name || '').toLowerCase() === needle)
    || monitors.find(m => String(m.name || '').toLowerCase().includes(needle))
    || null;
}

function getSubscriptionMentions(monitor) {
  const ids = Array.from(new Set(userSubscriptions[String(monitor?.id || '')] || []));
  return ids.length ? ids.map((id) => `<@${id}>`).join(' ') : '';
}

function toggleMonitorSubscription(monitorId, userId) {
  const key = String(monitorId);
  const current = Array.isArray(userSubscriptions[key]) ? userSubscriptions[key] : [];
  const exists = current.includes(userId);
  userSubscriptions[key] = exists
    ? current.filter((id) => id !== userId)
    : Array.from(new Set([...current, userId]));
  if (!userSubscriptions[key].length) delete userSubscriptions[key];
  persistState();
  return !exists;
}

function getSubscriptionsForUser(userId) {
  return Object.entries(userSubscriptions)
    .filter(([, userIds]) => Array.isArray(userIds) && userIds.includes(userId))
    .map(([monitorId]) => monitorId);
}

function getNextQuoteId() {
  return savedQuotes.reduce((maxId, entry) => Math.max(maxId, Number(entry.id) || 0), 0) + 1;
}

function addQuoteEntry({ guildId, text, authorId, authorName, addedById }) {
  const entry = {
    id: getNextQuoteId(),
    guildId: guildId || null,
    text: String(text || '').trim(),
    authorId: authorId || null,
    authorName: authorName || null,
    addedById,
    addedAt: new Date().toISOString(),
  };
  savedQuotes.push(entry);
  if (savedQuotes.length > 500) savedQuotes = savedQuotes.slice(-500);
  persistState();
  return entry;
}

function pickRandomQuote(guildId) {
  const pool = savedQuotes.filter((entry) => (guildId ? entry.guildId === guildId : true));
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function removeReminder(reminderId) {
  const key = String(reminderId);
  const timer = _reminderTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    _reminderTimers.delete(key);
  }
  pendingReminders = pendingReminders.filter((entry) => String(entry.id) !== key);
  persistState();
}

async function deliverReminder(reminderId) {
  const reminder = pendingReminders.find((entry) => String(entry.id) === String(reminderId));
  if (!reminder) return;
  const delay = new Date(reminder.remindAt).getTime() - Date.now();
  if (delay > 1000) {
    scheduleReminder(reminder);
    return;
  }

  const payload = `⏰ <@${reminder.userId}> Erinnerung: ${reminder.message}`;
  try {
    let delivered = false;
    if (reminder.channelId) {
      const channel = await client.channels.fetch(reminder.channelId).catch(() => null);
      if (channel?.isTextBased?.()) {
        await channel.send({ content: payload, allowedMentions: { users: [reminder.userId] } });
        delivered = true;
      }
    }
    if (!delivered) {
      const user = await client.users.fetch(reminder.userId).catch(() => null);
      if (user) {
        await user.send(`⏰ Erinnerung: ${reminder.message}`).catch(() => {});
      }
    }
  } catch (err) {
    logger.warn(`Reminder ${reminder.id} konnte nicht zugestellt werden: ${err.message}`);
  } finally {
    removeReminder(reminder.id);
  }
}

function scheduleReminder(reminder) {
  const key = String(reminder.id);
  const existing = _reminderTimers.get(key);
  if (existing) clearTimeout(existing);

  const delay = new Date(reminder.remindAt).getTime() - Date.now();
  if (!Number.isFinite(delay) || delay <= 0) {
    void deliverReminder(reminder.id);
    return;
  }

  const timeoutMs = Math.min(delay, 2147483647);
  const timer = setTimeout(() => {
    _reminderTimers.delete(key);
    void deliverReminder(reminder.id);
  }, timeoutMs);
  _reminderTimers.set(key, timer);
}

function addReminder({ userId, channelId, guildId, message, remindAt }) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId,
    channelId,
    guildId: guildId || null,
    message: String(message || '').trim(),
    remindAt: new Date(remindAt).toISOString(),
    createdAt: new Date().toISOString(),
  };
  pendingReminders.push(entry);
  persistState();
  scheduleReminder(entry);
  return entry;
}

function reschedulePendingReminders() {
  for (const timer of _reminderTimers.values()) clearTimeout(timer);
  _reminderTimers.clear();

  const now = Date.now();
  pendingReminders = pendingReminders.filter((entry) => new Date(entry.remindAt).getTime() > now - 60_000);
  persistState();
  for (const reminder of pendingReminders) scheduleReminder(reminder);
}
// #endregion

// #region 11. RATE-LIMIT SCHUTZ
let lastEditTimestamp = 0;
const MIN_EDIT_INTERVAL_MS  = 5_000;
const MIN_CHANNEL_RENAME_MS = 6 * 60 * 1000;  // 6 min sicherer Puffer (Discord: max 2/10min)
const STATUS_DOT = { green: '🟢', yellow: '🟡', red: '🔴' };
let statusUpdateInProgress = false;
let statusUpdateQueued = false;
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
  // Liefert die öffentliche URL zum internen Web-Server (für API-Endpoints wie /api/status-unfurl)
  const cloudflareUrl = config.get('cloudflare.publicUrl');
  if (cloudflareUrl) return cloudflareUrl.replace(/\/+$/, '');

  // Fallback: localhost (wenn kein Cloudflare konfiguriert)
  const webPort = config.get('webPort') || 3000;
  return `http://localhost:${webPort}`;
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

    // Konsistente Heuristik zur Diagnose-API:
    // Discord-Vorschau ist verlässlich bei Titel + (Beschreibung ODER Bild)
    const hasTitle = Boolean(ogTitle);
    const hasDescription = Boolean(ogDescription || metaDescription);
    const hasImage = Boolean(ogImage || twitterImage);
    const richPreview = Boolean(hasTitle && (hasDescription || hasImage));

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
  const webhookUrl = (config.get('discord.statusWebhookUrl') || '').trim();

  if (configuredMode === 'embed') {
    return { mode: 'custom_embed', publicStatusUrl };
  }

  if (configuredMode === 'webhook_ascii') {
    if (!webhookUrl) {
      logger.warn('Status Render Mode: webhook_ascii erzwungen, aber DISCORD_STATUS_WEBHOOK_URL fehlt - Fallback auf embed');
      return { mode: 'custom_embed', publicStatusUrl };
    }
    return { mode: 'webhook_ascii', publicStatusUrl };
  }

  if (configuredMode === 'svg_attachment') {
    return { mode: 'svg_attachment', publicStatusUrl };
  }

  if (!publicStatusUrl) {
    return { mode: 'svg_attachment', publicStatusUrl: null };
  }

  // "direct" Mode: Proxy mit injiziertem OG-Tags
  if (configuredMode === 'direct') {
    const reachable = await isStatusPageReachable(publicStatusUrl);
    if (reachable && webUrl) {
      return { mode: 'direct', proxyUrl: `${webUrl}/api/status-unfurl` };
    }
    logger.warn(`Status Render Mode: direct erzwungen, aber nicht erreichbar - Fallback auf embed`);
    return { mode: 'custom_embed', publicStatusUrl };
  }

  // "graphical" Mode: Link mit Badge-Bild
  if (configuredMode === 'graphical') {
    const reachable = await isStatusPageReachable(publicStatusUrl);
    if (reachable && webUrl) {
      return { mode: 'graphical', statusUrl: publicStatusUrl, badgeUrl: `${webUrl}/api/badge/summary` };
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
    return { mode: 'link_preview', publicStatusUrl };
  }

  // "auto" Mode: Wenn Webhook vorhanden, bevorzugt Webhook ASCII.
  if (webhookUrl) {
    return { mode: 'webhook_ascii', publicStatusUrl };
  }

  // "auto" Mode: Stabil vor schön.
  // Bei fehlenden OG-Metadaten sofort auf Embed wechseln statt fehlerhafte Link-Previews zu posten.
  const reachable = await isStatusPageReachable(publicStatusUrl);
  if (!reachable) {
    logger.warn(`Status Render Mode: auto - Statusseite nicht erreichbar, Fallback auf svg_attachment: ${publicStatusUrl}`);
    return { mode: 'svg_attachment', publicStatusUrl };
  }

  const preview = await inspectStatusPagePreview(publicStatusUrl);
  if (!preview.reachable || !preview.richPreview) {
    logger.warn('Status Render Mode: auto - OG Metadaten unzureichend, Fallback auf svg_attachment');
    return { mode: 'svg_attachment', publicStatusUrl };
  }

  // Nur wenn Metadaten ok sind, Link-Preview nutzen.
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
    url.searchParams.set('badge', badgeUrl);
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

function parseDiscordWebhookUrl(webhookUrl) {
  const match = String(webhookUrl || '').match(/^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/([^/]+)\/([^/?#]+)/i);
  if (!match) return null;
  return { id: match[1], token: match[2] };
}

async function enforceSingleStatusMessage(channel, keepMessageId) {
  if (!channel || !keepMessageId) return;

  let before = null;
  let deleted = 0;

  // Kanal historisch durchgehen und alles außer der aktuellen Status-Nachricht löschen.
  // Limit schützt vor Endlosschleifen und unnötig hoher API-Last.
  for (let page = 0; page < 20; page++) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    });

    if (!batch.size) break;

    for (const msg of batch.values()) {
      if (msg.id === keepMessageId) continue;
      try {
        await msg.delete();
        deleted++;
      } catch (err) {
        logger.warn(`Cleanup: Nachricht ${msg.id} konnte nicht gelöscht werden: ${err.message}`);
      }
    }

    before = batch.last()?.id || null;
    if (batch.size < 100) break;
  }

  if (deleted > 0) {
    logger.info(`Cleanup: ${deleted} alte Nachricht(en) aus Status-Channel entfernt`);
  }
}

function _toNonNegativeInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function getMessageCleanupChannels() {
  const configured = String(config.get('discord.messageCleanupChannelIds') || '').trim();
  const fallbackNotificationChannel = String(config.get('discord.notificationChannel') || '').trim();
  const raw = configured || fallbackNotificationChannel;
  if (!raw) return [];

  const seen = new Set();
  const result = [];

  for (const entry of raw.split(/[;,]/)) {
    const parts = entry.trim().split(':');
    const id = parts[0].trim();
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);

    const overrides = {};
    for (const part of parts.slice(1)) {
      const eqIdx = part.indexOf('=');
      if (eqIdx < 1) continue;
      const k = part.slice(0, eqIdx).trim().toLowerCase();
      const v = part.slice(eqIdx + 1).trim();
      if (k === 'maxmessages') overrides.maxMessages = _toNonNegativeInt(v, undefined);
      else if (k === 'maxagehours') overrides.maxAgeHours = _toNonNegativeInt(v, undefined);
      else if (k === 'cleanupintervalms') overrides.cleanupIntervalMs = _toNonNegativeInt(v, undefined);
    }
    // Remove undefined values so they don't overwrite global defaults
    Object.keys(overrides).forEach(k => overrides[k] === undefined && delete overrides[k]);

    result.push({ id, overrides });
  }

  return result;
}

function getMessageCleanupOptions(overrides = {}) {
  const configEnabled = config.get('discord.messageCleanupEnabled') === true;
  const configOnlyBot = config.get('discord.messageCleanupOnlyBotMessages') !== false;

  return {
    enabled: overrides.enabled ?? configEnabled,
    maxMessages: _toNonNegativeInt(overrides.maxMessages ?? config.get('discord.messageCleanupMaxMessages'), 0),
    maxAgeHours: _toNonNegativeInt(overrides.maxAgeHours ?? config.get('discord.messageCleanupMaxAgeHours'), 0),
    onlyBotMessages: overrides.onlyBotMessages ?? configOnlyBot,
    dryRun: overrides.dryRun === true,
  };
}

async function cleanupMessagesInChannel(channel, options = {}) {
  if (!channel || !channel.isTextBased?.()) {
    return { scanned: 0, eligible: 0, candidates: 0, deleted: 0, skipped: 0, reason: 'no-text-channel' };
  }

  const maxMessages = _toNonNegativeInt(options.maxMessages, 0);
  const maxAgeHours = _toNonNegativeInt(options.maxAgeHours, 0);
  const onlyBotMessages = options.onlyBotMessages !== false;
  const dryRun = options.dryRun === true;

  if (maxMessages === 0 && maxAgeHours === 0) {
    return { scanned: 0, eligible: 0, candidates: 0, deleted: 0, skipped: 0, reason: 'no-policy' };
  }

  const cutoffTs = maxAgeHours > 0 ? Date.now() - (maxAgeHours * 60 * 60 * 1000) : 0;
  let before = null;
  let scanned = 0;
  let eligible = 0;
  let candidates = 0;
  let deleted = 0;
  let skipped = 0;

  for (let page = 0; page < 20; page++) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    });
    if (!batch.size) break;

    for (const msg of batch.values()) {
      scanned++;
      if (msg.pinned) continue;
      if (onlyBotMessages && !msg.author?.bot) continue;

      eligible++;
      const overCount = maxMessages > 0 && eligible > maxMessages;
      const overAge = cutoffTs > 0 && msg.createdTimestamp < cutoffTs;
      if (!overCount && !overAge) continue;

      candidates++;
      if (dryRun) continue;

      try {
        await msg.delete();
        deleted++;
      } catch (err) {
        skipped++;
        logger.warn(`Nachrichten-Cleanup: Nachricht ${msg.id} in #${channel.name || channel.id} konnte nicht gelöscht werden: ${err.message}`);
      }
    }

    before = batch.last()?.id || null;
    if (batch.size < 100) break;
  }

  return { scanned, eligible, candidates, deleted, skipped, reason: 'ok' };
}

async function runConfiguredMessageCleanup() {
  try {
    const globalOptions = getMessageCleanupOptions();
    if (!globalOptions.enabled) return;

    const channels = getMessageCleanupChannels();
    if (!channels.length) {
      logger.warn('Nachrichten-Cleanup: aktiviert, aber keine Channel-IDs konfiguriert');
      return;
    }

    let totalDeleted = 0;
    for (const { id: channelId, overrides } of channels) {
      // Globale Optionen mit pro-Kanal-Overrides zusammenführen
      const channelOptions = Object.assign({}, globalOptions, overrides);

      let channel = client.channels.cache.get(channelId);
      if (!channel) {
        try {
          channel = await client.channels.fetch(channelId);
        } catch (err) {
          logger.warn(`Nachrichten-Cleanup: Kanal ${channelId} konnte nicht geladen werden: ${err.message}`);
          continue;
        }
      }

      const result = await cleanupMessagesInChannel(channel, channelOptions);
      totalDeleted += result.deleted;
      if (result.deleted > 0 || result.skipped > 0) {
        logger.info(`Nachrichten-Cleanup: #${channel.name || channel.id} gescannt=${result.scanned} kandidat=${result.candidates} gelöscht=${result.deleted} fehler=${result.skipped}`);
      }
    }

    if (totalDeleted > 0) {
      logger.info(`Nachrichten-Cleanup: insgesamt ${totalDeleted} Nachricht(en) gelöscht`);
    }
  } catch (err) {
    logger.error(`Nachrichten-Cleanup fehlgeschlagen: ${err.message}`);
  }
}

function buildAsciiUptimeBar(percent, width = 18) {
  const p = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const filled = Math.round((p / 100) * width);
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, width - filled));
}

function buildWebhookAsciiPayload(monitors, statusPageUrl = null) {
  const active = (monitors || []).filter(m => m.active !== false);
  const up = active.filter(m => m.status === 1).length;
  const total = active.length;
  const now = new Date().toLocaleString('de-DE', { hour12: false });

  const rows = active
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'de'))
    .map((m) => {
      const pct = Number.parseFloat(m.uptime) || 0;
      const icon = m.status === 1 ? '🟢' : m.status === 2 ? '🟡' : '🔴';
      const name = String(m.name || 'unknown').padEnd(18).slice(0, 18);
      const bar = buildAsciiUptimeBar(pct);
      const pctText = `${pct.toFixed(1)}%`.padStart(6);
      return `${icon} ${name} [${bar}] ${pctText}`;
    });

  const header = `📊 Dienste online: ${up}/${total}${statusPageUrl ? `\n🔗 ${statusPageUrl}` : ''}\n🕒 ${now}`;
  let block = '```\n' + rows.join('\n') + '\n```';

  // Webhook content limit = 2000 chars
  let content = `${header}\n${block}`;
  if (content.length > 1990) {
    const maxRows = Math.max(1, Math.floor((1900 - header.length) / 35));
    block = '```\n' + rows.slice(0, maxRows).join('\n') + '\n…\n```';
    content = `${header}\n${block}`;
  }

  return {
    username: 'Uptime Bot',
    content,
    allowed_mentions: { parse: [] }
  };
}

async function sendOrEditWebhookStatus(monitors, statusPageUrl = null) {
  const webhookUrl = (config.get('discord.statusWebhookUrl') || '').trim();
  if (!webhookUrl) {
    throw new Error('DISCORD_STATUS_WEBHOOK_URL ist leer');
  }

  const payload = buildWebhookAsciiPayload(monitors, statusPageUrl);
  const webhookMeta = parseDiscordWebhookUrl(webhookUrl);
  if (!webhookMeta) {
    throw new Error('DISCORD_STATUS_WEBHOOK_URL ist ungültig');
  }

  const baseApi = `https://discord.com/api/webhooks/${webhookMeta.id}/${webhookMeta.token}`;

  // Versuche bestehende Webhook-Nachricht zu editieren (ruhigere Historie)
  if (webhookStatusMessageId) {
    try {
      const editResp = await axios.patch(`${baseApi}/messages/${webhookStatusMessageId}`, payload, {
        timeout: 10_000,
        validateStatus: () => true
      });
      if (editResp.status >= 200 && editResp.status < 300) {
        return;
      }
      webhookStatusMessageId = null;
    } catch {
      webhookStatusMessageId = null;
    }
  }

  const resp = await axios.post(`${baseApi}?wait=true`, payload, {
    timeout: 10_000,
    validateStatus: () => true
  });
  if (!(resp.status >= 200 && resp.status < 300)) {
    throw new Error(`Webhook POST fehlgeschlagen (HTTP ${resp.status})`);
  }
  webhookStatusMessageId = resp.data?.id || null;
  persistState();
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

function _escapeSvgText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildStatusSvg(monitors) {
  const active = (monitors || []).filter(m => m.active !== false);
  const groups = [...new Set(active.map(m => m.group || 'General'))].sort((a, b) => a.localeCompare(b, 'de'));

  const servicesByGroup = {};
  for (const group of groups) {
    servicesByGroup[group] = active.filter(m => (m.group || 'General') === group);
  }

  const headerHeight = 90;
  const groupHeaderHeight = 36;
  const serviceHeight = 44;
  const groupSpacing = 22;

  let totalHeight = headerHeight + 20;
  for (const group of groups) {
    totalHeight += groupHeaderHeight + (servicesByGroup[group].length * serviceHeight) + groupSpacing;
  }
  totalHeight = Math.max(totalHeight, 200);

  const now = new Date().toLocaleString('de-DE', { hour12: false });

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${totalHeight}" viewBox="0 0 1000 ${totalHeight}">
  <rect width="1000" height="${totalHeight}" fill="#181c24"/>
  <rect width="1000" height="${headerHeight}" fill="#131720"/>
  <text x="30" y="52" font-family="Segoe UI, Arial, sans-serif" font-size="30" font-weight="700" fill="#f2f6ff">LIVE DIENSTE STATUS</text>
  <text x="670" y="52" font-family="Segoe UI, Arial, sans-serif" font-size="16" fill="#9aa4b6">Stand: ${_escapeSvgText(now)}</text>`;

  let currentY = headerHeight + 14;

  for (const group of groups) {
    const services = servicesByGroup[group];
    svg += `
  <rect x="24" y="${currentY}" width="952" height="${groupHeaderHeight}" rx="6" fill="#2a303b"/>
  <text x="40" y="${currentY + 24}" font-family="Segoe UI, Arial, sans-serif" font-size="18" font-weight="700" fill="#ffffff">${_escapeSvgText(group.toUpperCase())} [${services.length}]</text>`;

    currentY += groupHeaderHeight + 8;

    for (const monitor of services) {
      const isUp = monitor.status === 1;
      const isPending = monitor.status === 2;
      const color = isUp ? '#3fb950' : isPending ? '#e3a341' : '#f85149';
      const statusText = isUp ? 'OPERATIONAL' : isPending ? 'PENDING' : 'OUTAGE';
      const pct = Math.max(0, Math.min(100, Number.parseFloat(monitor.uptime) || 0));
      const barWidth = Math.max(2, Math.round((pct / 100) * 250));
      const timeText = monitor.time
        ? new Date(monitor.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : '--:--:--';

      svg += `
  <circle cx="44" cy="${currentY + 16}" r="7" fill="${color}"/>
  <text x="62" y="${currentY + 21}" font-family="Segoe UI, Arial, sans-serif" font-size="16" font-weight="700" fill="#ecf1fb">${_escapeSvgText(monitor.name)}</text>
  <text x="360" y="${currentY + 21}" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="700" fill="${color}">${statusText}</text>
  <rect x="510" y="${currentY + 6}" width="250" height="18" rx="4" fill="#4a5568"/>
  <rect x="510" y="${currentY + 6}" width="${barWidth}" height="18" rx="4" fill="${color}"/>
  <text x="774" y="${currentY + 21}" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="700" fill="#ecf1fb">${pct.toFixed(1)}%</text>
  <text x="850" y="${currentY + 21}" font-family="Segoe UI, Arial, sans-serif" font-size="12" fill="#9aa4b6">${_escapeSvgText(timeText)}</text>`;

      currentY += serviceHeight;
    }

    currentY += groupSpacing;
  }

  svg += `
  <text x="24" y="${totalHeight - 12}" font-family="Segoe UI, Arial, sans-serif" font-size="12" fill="#95a2b8">Uptime Kuma Status - automatisch generiert</text>
</svg>`;

  return svg;
}

async function convertSvgToPngBuffer(svgContent) {
  const tmpDir = path.join(__dirname, 'data', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const svgFilePath = path.join(tmpDir, `status-${stamp}.svg`);
  const pngFilePath = path.join(tmpDir, `status-${stamp}.png`);

  fs.writeFileSync(svgFilePath, svgContent, 'utf8');

  try {
    await new Promise((resolve, reject) => {
      execFile('rsvg-convert', ['-w', '1000', svgFilePath, '-o', pngFilePath], { timeout: 12_000 }, (err, stdout, stderr) => {
        if (err) {
          const details = (stderr || stdout || err.message || '').toString().trim();
          reject(new Error(details || 'rsvg-convert fehlgeschlagen'));
          return;
        }
        resolve();
      });
    });

    return fs.readFileSync(pngFilePath);
  } catch (err) {
    throw new Error(`SVG-Konvertierung fehlgeschlagen (${err.message}). Installiere auf dem Raspberry Pi: sudo apt-get install -y librsvg2-bin`);
  } finally {
    try { fs.unlinkSync(svgFilePath); } catch { /* ignore */ }
    try { fs.unlinkSync(pngFilePath); } catch { /* ignore */ }
  }
}

async function buildSvgAttachmentPayload(monitors, statusPageUrl = null) {
  const svg = buildStatusSvg(monitors);
  const pngBuffer = await convertSvgToPngBuffer(svg);
  const attachment = new AttachmentBuilder(pngBuffer, { name: 'status.png' });

  const title = String(config.get('discord.statusMessageTitle') || '').trim();
  const buttonLabel = String(config.get('discord.statusButtonLabel') || '').trim().slice(0, 80);

  const payload = {
    embeds: [],
    files: [attachment]
  };

  // Optionaler Text oberhalb der Grafik (leer = keine doppelte Überschrift).
  if (title) payload.content = `🌐 **${title}**`;

  // Optionaler Link-Button statt roher URL im Content (verhindert Discord-Autounfurl-Button).
  const webUiButtonLabel = String(config.get('discord.statusWebUiButtonLabel') || '').trim().slice(0, 80);
  const webUiUrl = getWebUrl();
  const showWebUiButton = Boolean(webUiButtonLabel && webUiUrl && webUiUrl.startsWith('https://'));

  if ((statusPageUrl && buttonLabel) || showWebUiButton) {
    const row = new ActionRowBuilder();
    if (statusPageUrl && buttonLabel) {
      row.addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel(buttonLabel)
          .setURL(statusPageUrl)
      );
    }
    if (showWebUiButton) {
      row.addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel(webUiButtonLabel)
          .setURL(webUiUrl)
      );
    }
    payload.components = [row];
  }

  return payload;
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
    persistState();
    logger.info(`Channel-Indikator: ${channel.name} → ${newName} | ${newTopic}`);
  } catch (err) {
    logger.error(`Channel-Indikator fehlgeschlagen: ${err.message}`);
  }
}
// #endregion

// #region 16b. DISCORD STATUS-NACHRICHT
async function updateStatusMessage() {
  if (statusUpdateInProgress) {
    statusUpdateQueued = true;
    logger.warn('Status-Update bereits aktiv - neuer Run wird in Queue gelegt');
    return;
  }

  statusUpdateInProgress = true;
  try {
    const now = Date.now();
    if (now - lastEditTimestamp < MIN_EDIT_INTERVAL_MS) {
      logger.warn('Rate-Limit-Schutz: Update übersprungen (zu schnell aufgerufen)');
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

    // ── Nachricht: Multi-Mode Support (direct / graphical / link_preview / svg_attachment / webhook_ascii / embed) ────
    const renderDecision = await getStatusRenderMode();

    // Webhook-Mode hat einen eigenen Versandpfad ohne Discord Channel Message.
    if (renderDecision.mode === 'webhook_ascii') {
      try {
        await sendOrEditWebhookStatus(monitors, renderDecision.publicStatusUrl || getPublicStatusUrl());
        lastEditTimestamp = Date.now();
        logger.info(`Status aktualisiert via Webhook ASCII: ${operationalCount}/${monitors.length} Dienste online`);
        await syncServiceChannels(monitors);
        return;
      } catch (error) {
        logger.error(`Webhook-Statusfehler: ${error.message}`);
        // Fallback auf Standard-Embed im Status-Channel
      }
    }

    const channelId = config.get('discord.statusChannelId');
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
      logger.error('Ung\u00fcltige discord.statusChannelId \u2013 Channel nicht gefunden');
      return;
    }

    const statusEmbed = buildStatusEmbed(monitors, renderDecision.publicStatusUrl);

    let messagePayload = { content: null, embeds: [statusEmbed] };

    if (renderDecision.mode === 'direct') {
      messagePayload = { content: buildStatusDirectMessage(renderDecision.proxyUrl), embeds: [] };
    } else if (renderDecision.mode === 'graphical') {
      messagePayload = { content: buildStatusGraphicalMessage(renderDecision.statusUrl, renderDecision.badgeUrl), embeds: [] };
    } else if (renderDecision.mode === 'link_preview') {
      messagePayload = { content: buildStatusLinkPreviewMessage(renderDecision.publicStatusUrl), embeds: [] };
    } else if (renderDecision.mode === 'svg_attachment') {
      try {
        messagePayload = await buildSvgAttachmentPayload(monitors, renderDecision.publicStatusUrl || getPublicStatusUrl());
      } catch (err) {
        logger.warn(`SVG-Render fehlgeschlagen, Fallback auf Embed: ${err.message}`);
        messagePayload = { content: null, embeds: [statusEmbed] };
      }
    }

    try {
      if (statusMessageId) {
        try {
          const existingMessage = await channel.messages.fetch(statusMessageId);
          // Für Link-Preview Modi: Lösche alte Message und sende neu (Discord unfurlt nur neue Messages)
          if (['direct', 'graphical', 'link_preview', 'svg_attachment'].includes(renderDecision.mode)) {
            await existingMessage.delete();
            const newMessage = await channel.send(messagePayload);
            statusMessageId = newMessage.id;
            persistState();
          } else {
            // Für Embeds: Normal editieren
            await existingMessage.edit(messagePayload);
          }
        } catch (err) {
          logger.warn(`Vorherige Status-Nachricht konnte nicht aktualisiert werden (${err.message}) - sende neue Nachricht`);
          const newMessage = await channel.send(messagePayload);
          statusMessageId = newMessage.id;
          persistState();
        }
      } else {
        const newMessage = await channel.send(messagePayload);
        statusMessageId = newMessage.id;
        persistState();
      }
      lastEditTimestamp = Date.now();
      logger.info(`Status aktualisiert: ${operationalCount}/${monitors.length} Dienste online`);
      logger.info(`Status Render Mode: ${renderDecision.mode}${renderDecision.publicStatusUrl ? ` | ${renderDecision.publicStatusUrl}` : renderDecision.proxyUrl ? ` | proxy` : ``}`);

      await enforceSingleStatusMessage(channel, statusMessageId);

      // Channel-Name + Topic bei Statuswechsel aktualisieren
      await updateChannelIndicator(channel, monitors);
      // Service-Kanäle in der Kanalleiste aktualisieren
      await syncServiceChannels(monitors);
    } catch (error) {
      logger.error(`Discord-Nachrichtenfehler: ${error.message}`);
      statusMessageId = null;
    }
  } finally {
    statusUpdateInProgress = false;
    if (statusUpdateQueued) {
      statusUpdateQueued = false;
      setTimeout(() => {
        updateStatusMessage().catch(err => logger.error(`Queued Status-Update fehlgeschlagen: ${err.message}`));
      }, 750);
    }
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
 *   SERVICE_GUILD_ID      – optionale Guild-ID nur für Service-Kanäle (Fallback: GUILD_ID)
 *   GUILD_ID              – Guild-ID des Servers (Fallback, wenn SERVICE_GUILD_ID leer)
 *   SERVICE_CATEGORY_NAME – Kategoriename (Standard: "📊 Service Status")
 *   MONITORED_SERVICES    – kommagetrennte Whitelist, z.B. "nginx,database,api"
 *                           (leer = alle aktiven Dienste)
 *
 * Discord Rate-Limit: max. 2 Umbenennungen pro Kanal / 10 Minuten.
 * Der Cooldown von 6 Minuten (MIN_CHANNEL_RENAME_MS) wird auch hier eingehalten.
 */
function _serviceChannelName(monitorName, status, mode = 'strict_slug') {
  const dot  = status === 1 ? '🟢' : status === 0 ? '🔴' : '🟡';

  const toMono = (value) => Array.from(value).map((ch) => {
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D670 + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D68A + (code - 97));
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7F6 + (code - 48));
    return ch;
  }).join('');

  if (mode === 'pretty') {
    // "pretty" versucht Groß/Kleinschreibung und Emoji beizubehalten.
    // Falls Discord den Namen ablehnt, wird in syncServiceChannels auf strict_slug zurückgefallen.
    const pretty = String(monitorName || 'service')
      .trim()
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/[\n\r\t]+/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/#+/g, '-')
      .replace(/:+/g, '-')
      .replace(/@+/g, '-')
      .replace(/\/+|\\+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90);
    return `${dot}-${pretty || 'service'}`;
  }

  if (mode === 'mono') {
    // "mono" nutzt mathematische Monospace-Zeichen als visuellen Look.
    // Falls Discord den Namen ablehnt, wird in syncServiceChannels auf strict_slug zurückgefallen.
    const base = String(monitorName || 'service')
      .trim()
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/[\n\r\t]+/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/#+/g, '-')
      .replace(/:+/g, '-')
      .replace(/@+/g, '-')
      .replace(/\/+|\\+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90);
    return `${dot}-${toMono(base || 'service')}`;
  }

  const slug = String(monitorName || 'service')
    .toLowerCase()
    .replace(/[äöüß]/g, c => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 94);
  return `${dot}-${slug || 'service'}`;
}

function _withStatusDot(channelName, status, fallbackName) {
  const dot = status === 1 ? '🟢' : status === 0 ? '🔴' : '🟡';
  const current = String(channelName || '').trim();
  if (!current) return fallbackName;

  // Bestehenden Namen beibehalten und nur den führenden Statuspunkt ersetzen.
  if (/^[🟢🟡🔴]/u.test(current)) {
    return `${dot}${current.replace(/^[🟢🟡🔴]/u, '')}`;
  }

  return `${dot}${current}`;
}

function _parseServiceChannelMap(rawMap) {
  const map = {};
  const source = String(rawMap || '').trim();
  if (!source) return map;

  const entries = source.split(';').map(s => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const idx = entry.lastIndexOf('=');
    if (idx <= 0) continue;
    const monitor = entry.slice(0, idx).trim();
    const channelId = entry.slice(idx + 1).trim();
    if (!monitor || !/^\d+$/.test(channelId)) continue;
    map[_normalizeServiceKey(monitor)] = channelId;
  }

  return map;
}

function _normalizeServiceKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[äöüß]/g, c => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c] ?? c)
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function syncServiceChannels(monitors) {
  const serviceGuildId = String(config.get('discord.serviceGuildId') || '').trim();
  const guildId = serviceGuildId || String(config.get('discord.guildId') || '').trim();
  if (!guildId) return;  // Feature nicht konfiguriert
  const namingMode = config.get('discord.serviceChannelNameMode') || 'strict_slug';
  const autoCreate = config.get('discord.serviceChannelAutoCreate') !== false;
  const autoQuiet = config.get('discord.serviceChannelAutoQuiet') !== false;
  const fixedCategoryId = String(config.get('discord.serviceCategoryId') || '').trim();
  const manualChannelMap = _parseServiceChannelMap(config.get('discord.serviceChannelMap') || '');
  const debugEnabled = config.get('discord.serviceChannelDebug') === true;
  const debugFilterSet = new Set(
    String(config.get('discord.serviceChannelDebugFilter') || '')
      .split(',')
      .map(s => _normalizeServiceKey(s))
      .filter(Boolean)
  );
  const shouldDebugMonitor = (monitorName) => {
    if (!debugEnabled) return false;
    if (!debugFilterSet.size) return true;
    return debugFilterSet.has(_normalizeServiceKey(monitorName || ''));
  };

  const quietDenyPerms = [
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.CreatePublicThreads,
    PermissionFlagsBits.CreatePrivateThreads,
    PermissionFlagsBits.SendMessagesInThreads,
  ];

  const ensureQuietPermissions = async (channel) => {
    if (!autoQuiet || !channel || channel.type !== ChannelType.GuildText) return;
    try {
      const overwrite = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
      const missing = quietDenyPerms.filter((perm) => !overwrite?.deny?.has(perm));
      if (!missing.length) return;
      await channel.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: false,
        AddReactions: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
        SendMessagesInThreads: false,
      });
    } catch (err) {
      logger.warn(`Service-Kanal-Manager: Ruhigstellen für "${channel.name}" fehlgeschlagen: ${err.message}`);
    }
  };

  let guild = client.guilds.cache.get(guildId);
  if (!guild) {
    try {
      guild = await client.guilds.fetch(guildId);
    } catch {
      logger.warn(`Service-Kanal-Manager: Guild "${guildId}" nicht gefunden – stimmt SERVICE_GUILD_ID/GUILD_ID und ist der Bot auf dem Server?`);
      return;
    }
  }

  // Ohne ManageChannels kann der Bot weder Kategorie/Kanal erstellen noch umbenennen.
  try {
    const me = guild.members.me || await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      logger.warn('Service-Kanal-Manager: Fehlende Berechtigung "Manage Channels". Kategorie/Kanal-Änderungen übersprungen.');
      return;
    }
  } catch {
    logger.warn('Service-Kanal-Manager: Bot-Mitgliedsdaten konnten nicht geladen werden (Berechtigungen nicht prüfbar).');
  }

  // Zielmenge ermitteln: MONITORED_SERVICES hat Vorrang, sonst SERVICE_CHANNEL_MAP.
  // Wenn beides leer ist, werden keine Service-Kanäle synchronisiert.
  const whitelist = (config.get('discord.monitoredServices') || '')
    .split(',').map(s => _normalizeServiceKey(s)).filter(Boolean);

  // MONITORED_SERVICES hat Vorrang.
  // SERVICE_CHANNEL_MAP dient nur als Quelle, wenn keine Whitelist gesetzt ist.
  const targetNames = whitelist.length
    ? new Set(whitelist)
    : new Set(Object.keys(manualChannelMap));

  if (!targetNames.size) return;

  const targets = monitors.filter(m => targetNames.has(_normalizeServiceKey(m.name || '')));

  if (!targets.length) return;

  let category = null;

  if (autoCreate) {
    // ── Kategorie sicherstellen (nur erforderlich bei Auto-Erstellung) ─────
    if (fixedCategoryId) {
      const byId = guild.channels.cache.get(fixedCategoryId);
      if (byId && byId.type === ChannelType.GuildCategory) {
        category = byId;
      } else {
        logger.warn(`Service-Kanal-Manager: SERVICE_CATEGORY_ID "${fixedCategoryId}" nicht gefunden oder keine Kategorie`);
      }
    }

    if (!category) {
      category = serviceCategoryId ? guild.channels.cache.get(serviceCategoryId) : null;
      if (category && category.type !== ChannelType.GuildCategory) {
        category = null;
      }
    }

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
      persistState();
    }
  }

  // ── Kanäle erstellen / umbenennen ─────────────────────────────────────────
  const now = Date.now();
  let stateChanged = false;

  for (const monitor of targets) {
    const monitorKey = _normalizeServiceKey(monitor.name || '');
    let desiredName = _serviceChannelName(monitor.name, monitor.status, namingMode);
    const fallbackName = _serviceChannelName(monitor.name, monitor.status, 'strict_slug');
    const topic       = `📈 Uptime: ${monitor.uptime ?? '–'}%  ⏱ Ping: ${monitor.ping != null ? monitor.ping + 'ms' : '–'}`;
    const mappedChannelId = manualChannelMap[monitorKey] || null;
    const stateChannelIdByName = serviceChannels[monitor.name] || null;
    const stateChannelIdByKey = serviceChannels[monitorKey] || null;
    const stateChannelIdByNormalizedMatch = Object.entries(serviceChannels)
      .find(([name]) => _normalizeServiceKey(name) === monitorKey)?.[1] || null;
    let channelId     = mappedChannelId || stateChannelIdByName || stateChannelIdByKey || stateChannelIdByNormalizedMatch;
    let channel       = channelId ? guild.channels.cache.get(channelId) : null;
    const debugThis = shouldDebugMonitor(monitor.name);

    if (channelId && !channel) {
      try {
        channel = await guild.channels.fetch(channelId);
      } catch {
        channel = null;
      }
    }

    if (debugThis) {
      logger.info(`Service-Kanal-Debug: monitor="${monitor.name}" key="${monitorKey}" status=${monitor.status} mapped=${mappedChannelId || '-'} stateByName=${stateChannelIdByName || '-'} stateByKey=${stateChannelIdByKey || '-'} stateByNormalized=${stateChannelIdByNormalizedMatch || '-'} resolved=${channelId || '-'} channel=${channel?.id || '-'} currentName="${channel?.name || '-'}" desiredName="${desiredName}"`);
    }

    if (mappedChannelId && !channel) {
      logger.warn(`Service-Kanal-Manager: Mapping für "${monitor.name}" auf Kanal ${mappedChannelId}, aber Kanal nicht gefunden`);
    }

    if (mappedChannelId && channel && (serviceChannels[monitor.name] !== mappedChannelId || serviceChannels[monitorKey] !== mappedChannelId)) {
      serviceChannels[monitor.name] = mappedChannelId;
      serviceChannels[monitorKey] = mappedChannelId;
      stateChanged = true;
    }

    // Kanal existiert nicht → erstellen
    if (!channel) {
      if (!autoCreate) {
        logger.warn(`Service-Kanal-Manager: Kein Kanal für "${monitor.name}" vorhanden und Auto-Erstellung ist deaktiviert`);
        continue;
      }
      if (!category) {
        logger.warn(`Service-Kanal-Manager: Keine Kategorie verfügbar für Auto-Erstellung von "${monitor.name}"`);
        continue;
      }
      try {
        channel = await guild.channels.create({
          name:   desiredName,
          type:   ChannelType.GuildText,
          parent: category.id,
          topic,
          permissionOverwrites: autoQuiet
            ? [{ id: guild.roles.everyone, deny: quietDenyPerms }]
            : [{ id: guild.roles.everyone, deny: [PermissionFlagsBits.SendMessages] }]
        });
        serviceChannels[monitor.name] = channel.id;
        serviceChannels[monitorKey] = channel.id;
        stateChanged = true;
        logger.info(`Service-Kanal-Manager: Kanal "${desiredName}" erstellt`);
      } catch (err) {
        if (namingMode !== 'strict_slug' && fallbackName !== desiredName) {
          try {
            channel = await guild.channels.create({
              name:   fallbackName,
              type:   ChannelType.GuildText,
              parent: category.id,
              topic,
              permissionOverwrites: autoQuiet
                ? [{ id: guild.roles.everyone, deny: quietDenyPerms }]
                : [{ id: guild.roles.everyone, deny: [PermissionFlagsBits.SendMessages] }]
            });
            serviceChannels[monitor.name] = channel.id;
            serviceChannels[monitorKey] = channel.id;
            stateChanged = true;
            logger.warn(`Service-Kanal-Manager: Modus "${namingMode}" abgelehnt, Fallback auf "${fallbackName}" für "${monitor.name}"`);
          } catch (fallbackErr) {
            logger.error(`Service-Kanal-Manager: Kanal für "${monitor.name}" fehlgeschlagen: ${fallbackErr.message}`);
            continue;
          }
        } else {
          logger.error(`Service-Kanal-Manager: Kanal für "${monitor.name}" fehlgeschlagen: ${err.message}`);
          continue;
        }
      }
    }

    if (channel.type !== ChannelType.GuildText) {
      logger.warn(`Service-Kanal-Manager: Kanal für "${monitor.name}" ist kein Textkanal (${channel.type})`);
      continue;
    }

    desiredName = _withStatusDot(channel.name, monitor.status, desiredName);

    await ensureQuietPermissions(channel);

    // Kanal umbenennen wenn Status sich geändert hat
    if (channel.name !== desiredName) {
      const lastRename = _svcRenameMs[channel.id] ?? 0;
      if (now - lastRename < MIN_CHANNEL_RENAME_MS) {
        const cooldown = Math.ceil((MIN_CHANNEL_RENAME_MS - (now - lastRename)) / 1000);
        logger.warn(`Service-Kanal-Manager: "${monitor.name}" wartet noch ${cooldown}s (Rate-Limit)`);
        if (debugThis) {
          logger.info(`Service-Kanal-Debug: monitor="${monitor.name}" rename-blocked cooldown=${cooldown}s current="${channel.name}" target="${desiredName}"`);
        }
        continue;
      }
      try {
        await channel.edit({ name: desiredName, topic });
        _svcRenameMs[channel.id] = now;
        logger.info(`Service-Kanal-Manager: "${channel.name}" → "${desiredName}"`);
        if (debugThis) {
          logger.info(`Service-Kanal-Debug: monitor="${monitor.name}" renamed channelId=${channel.id} newName="${desiredName}"`);
        }
      } catch (err) {
        if (namingMode !== 'strict_slug' && fallbackName !== desiredName) {
          try {
            await channel.edit({ name: fallbackName, topic });
            _svcRenameMs[channel.id] = now;
            logger.warn(`Service-Kanal-Manager: Modus "${namingMode}" bei Umbenennung abgelehnt, Fallback auf "${fallbackName}" für "${monitor.name}"`);
          } catch (fallbackErr) {
            logger.error(`Service-Kanal-Manager: Umbenennen "${monitor.name}" fehlgeschlagen: ${fallbackErr.message}`);
          }
        } else {
          logger.error(`Service-Kanal-Manager: Umbenennen "${monitor.name}" fehlgeschlagen: ${err.message}`);
        }
      }
    }
  }

  if (stateChanged) {
    persistState();
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
const AVAILABLE_SLASH_COMMANDS = ['status', 'uptime', 'refresh', 'help', 'coinflip', 'dice', 'eightball', 'cleanup', 'translate', 'ping', 'botinfo', 'serverstatus', 'ki', 'wetter', 'subscribe', 'remind', 'quote', 'poll', 'avatar', 'userinfo', 'testreply'];
const SLASH_COMMAND_I18N = {
  status: {
    names: { de: 'status' },
    descriptions: {
      'de': 'Zeigt den aktuellen Status aller Services',
      'en-US': 'Shows the current status of all services',
      'en-GB': 'Shows the current status of all services',
    },
  },
  uptime: {
    names: { de: 'betriebszeit' },
    descriptions: {
      'de': 'Zeigt die Gesamt-Uptime aller aufgezeichneten Checks',
      'en-US': 'Shows the total uptime across all recorded checks',
      'en-GB': 'Shows the total uptime across all recorded checks',
    },
  },
  refresh: {
    names: { de: 'aktualisieren' },
    descriptions: {
      'de': 'Erzwingt einen sofortigen Status-Refresh (nur Admins)',
      'en-US': 'Forces an immediate status refresh (admins only)',
      'en-GB': 'Forces an immediate status refresh (admins only)',
    },
  },
  help: {
    names: { de: 'hilfe' },
    descriptions: {
      'de': 'Zeigt alle verfügbaren Bot-Kommandos',
      'en-US': 'Shows all available bot commands',
      'en-GB': 'Shows all available bot commands',
    },
  },
  coinflip: {
    names: { de: 'muenzwurf' },
    descriptions: {
      'de': 'Wirft eine Münze (Kopf oder Zahl)',
      'en-US': 'Flips a coin (heads or tails)',
      'en-GB': 'Flips a coin (heads or tails)',
    },
  },
  dice: {
    names: { de: 'wuerfeln' },
    descriptions: {
      'de': 'Würfelt eine Zahl mit frei wählbaren Seiten',
      'en-US': 'Rolls a die with a selectable number of sides',
      'en-GB': 'Rolls a die with a selectable number of sides',
    },
  },
  eightball: {
    names: { de: 'achtball' },
    descriptions: {
      'de': 'Magische 8-Ball Antwort auf deine Frage',
      'en-US': 'Magic 8-ball answer to your question',
      'en-GB': 'Magic 8-ball answer to your question',
    },
  },
  cleanup: {
    names: { de: 'bereinigen' },
    descriptions: {
      'de': 'Bereinigt Kanal-Nachrichten anhand der Cleanup-Regeln',
      'en-US': 'Cleans channel messages using the cleanup rules',
      'en-GB': 'Cleans channel messages using the cleanup rules',
    },
  },
  translate: {
    names: { de: 'uebersetzen' },
    descriptions: {
      'de': 'Uebersetzt Text (z. B. Englisch <-> Deutsch)',
      'en-US': 'Translates text (for example English <-> German)',
      'en-GB': 'Translates text (for example English <-> German)',
    },
  },
  ping: {
    names: { de: 'ping' },
    descriptions: {
      'de': 'Zeigt die aktuelle Bot-Latenz',
      'en-US': 'Shows the current bot latency',
      'en-GB': 'Shows the current bot latency',
    },
  },
  botinfo: {
    names: { de: 'botinfo' },
    descriptions: {
      'de': 'Zeigt technische Informationen über den Bot',
      'en-US': 'Shows technical information about the bot',
      'en-GB': 'Shows technical information about the bot',
    },
  },
  serverstatus: {
    names: { de: 'dienststatus' },
    descriptions: {
      'de': 'Zeigt den Status eines einzelnen Dienstes oder einer Gruppe',
      'en-US': 'Shows the status of a single service or group',
      'en-GB': 'Shows the status of a single service or group',
    },
  },
  ki: {
    names: { de: 'ki' },
    descriptions: {
      'de': 'Stellt dem KI-Chatbot direkt eine Frage',
      'en-US': 'Ask the AI chatbot a question directly',
      'en-GB': 'Ask the AI chatbot a question directly',
    },
  },
  wetter: {
    names: { de: 'wetter' },
    descriptions: {
      'de': 'Zeigt das aktuelle Wetter für einen Ort',
      'en-US': 'Shows the current weather for a location',
      'en-GB': 'Shows the current weather for a location',
    },
  },
  subscribe: {
    names: { de: 'abonnieren' },
    descriptions: {
      'de': 'Abonniert Statusänderungen für einen Dienst oder listet deine Abos',
      'en-US': 'Subscribe to service status changes or list your subscriptions',
      'en-GB': 'Subscribe to service status changes or list your subscriptions',
    },
  },
  remind: {
    names: { de: 'erinnern' },
    descriptions: {
      'de': 'Setzt eine Erinnerung',
      'en-US': 'Sets a reminder',
      'en-GB': 'Sets a reminder',
    },
  },
  quote: {
    names: { de: 'zitat' },
    descriptions: {
      'de': 'Speichert ein Zitat oder zeigt ein zufälliges an',
      'en-US': 'Stores a quote or shows a random one',
      'en-GB': 'Stores a quote or shows a random one',
    },
  },
  poll: {
    names: { de: 'umfrage' },
    descriptions: {
      'de': 'Erstellt eine einfache Umfrage mit Reaktionen',
      'en-US': 'Creates a simple poll with reactions',
      'en-GB': 'Creates a simple poll with reactions',
    },
  },
  avatar: {
    names: { de: 'avatar' },
    descriptions: {
      'de': 'Zeigt den Avatar eines Nutzers',
      'en-US': 'Shows a user avatar',
      'en-GB': 'Shows a user avatar',
    },
  },
  userinfo: {
    names: { de: 'nutzerinfo' },
    descriptions: {
      'de': 'Zeigt Informationen über einen Nutzer',
      'en-US': 'Shows information about a user',
      'en-GB': 'Shows information about a user',
    },
  },
};

const SLASH_OPTION_ALIASES = {
  dice: { seiten: ['seiten', 'sides'] },
  eightball: { frage: ['frage', 'question'] },
  cleanup: {
    kanal: ['kanal', 'channel'],
    max_nachrichten: ['max_nachrichten', 'max_messages'],
    max_alter_stunden: ['max_alter_stunden', 'max_age_hours'],
    nur_bot: ['nur_bot', 'only_bot'],
    dry_run: ['dry_run'],
  },
  translate: {
    text: ['text'],
    ziel: ['ziel', 'target'],
    quelle: ['quelle', 'source'],
  },
  serverstatus: {
    dienst: ['dienst', 'service'],
    gruppe: ['gruppe', 'group'],
  },
  ki: { frage: ['frage', 'question', 'prompt'] },
  wetter: { ort: ['ort', 'location'] },
  subscribe: { dienst: ['dienst', 'service'] },
  remind: { zeit: ['zeit', 'time'], text: ['text'] },
  quote: { text: ['text'] },
  poll: {
    frage: ['frage', 'question'],
    option1: ['option1'],
    option2: ['option2'],
    option3: ['option3'],
    option4: ['option4'],
    option5: ['option5'],
  },
  avatar: { nutzer: ['nutzer', 'user'] },
  userinfo: { nutzer: ['nutzer', 'user'] },
};

function applySlashCommandI18n(builder, commandKey) {
  const meta = SLASH_COMMAND_I18N[commandKey];
  if (!meta) return builder;
  if (meta.names) builder.setNameLocalizations(meta.names);
  if (meta.descriptions) builder.setDescriptionLocalizations(meta.descriptions);
  return builder;
}

function applySlashOptionI18n(option, config) {
  if (!config) return option;
  if (config.names) option.setNameLocalizations(config.names);
  if (config.descriptions) option.setDescriptionLocalizations(config.descriptions);
  return option;
}

function isGermanDiscordLocale(locale) {
  return String(locale || '').toLowerCase().startsWith('de');
}

function getSlashCommandDisplayName(commandKey, locale) {
  const meta = SLASH_COMMAND_I18N[commandKey];
  if (meta && isGermanDiscordLocale(locale) && meta.names?.de) return meta.names.de;
  return commandKey;
}

function resolveCanonicalCommandName(name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) return raw;
  if (AVAILABLE_SLASH_COMMANDS.includes(raw)) return raw;
  for (const [commandKey, meta] of Object.entries(SLASH_COMMAND_I18N)) {
    if (Object.values(meta.names || {}).some((localizedName) => String(localizedName).toLowerCase() === raw)) {
      return commandKey;
    }
  }
  return raw;
}

function getSlashOptionAliases(commandKey, optionKey) {
  const aliases = SLASH_OPTION_ALIASES[commandKey]?.[optionKey] || [optionKey];
  return Array.from(new Set([optionKey, ...aliases]));
}

function getSlashStringOption(interaction, commandKey, optionKey) {
  for (const alias of getSlashOptionAliases(commandKey, optionKey)) {
    const value = interaction.options.getString(alias, false);
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function getSlashIntegerOption(interaction, commandKey, optionKey) {
  for (const alias of getSlashOptionAliases(commandKey, optionKey)) {
    const value = interaction.options.getInteger(alias, false);
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function getSlashBooleanOption(interaction, commandKey, optionKey) {
  for (const alias of getSlashOptionAliases(commandKey, optionKey)) {
    const value = interaction.options.getBoolean(alias, false);
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function getSlashChannelOption(interaction, commandKey, optionKey) {
  for (const alias of getSlashOptionAliases(commandKey, optionKey)) {
    const value = interaction.options.getChannel(alias, false);
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function getSlashUserOption(interaction, commandKey, optionKey) {
  for (const alias of getSlashOptionAliases(commandKey, optionKey)) {
    const value = interaction.options.getUser(alias, false);
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function getEnabledSlashCommands() {
  const legacyDefault = ['status', 'uptime', 'refresh', 'help', 'coinflip', 'dice', 'eightball', 'cleanup', 'translate'];
  const raw = String(config.get('discord.enabledCommands') || '').trim();
  const entries = raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const unique = Array.from(new Set(entries)).filter(cmd => AVAILABLE_SLASH_COMMANDS.includes(cmd));
  if (unique.length === legacyDefault.length && legacyDefault.every((cmd) => unique.includes(cmd))) {
    return [...AVAILABLE_SLASH_COMMANDS];
  }
  return unique.length ? unique : [...AVAILABLE_SLASH_COMMANDS];
}

async function registerSlashCommands() {
  const enabled = new Set(getEnabledSlashCommands());
  const commands = [];

  if (enabled.has('status')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('status')
        .setDescription('Zeigt den aktuellen Status aller Services'), 'status')
        .toJSON()
    );
  }

  if (enabled.has('uptime')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('uptime')
        .setDescription('Zeigt die Gesamt-Uptime aller aufgezeichneten Checks'), 'uptime')
        .toJSON()
    );
  }

  if (enabled.has('refresh')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('refresh')
        .setDescription('Erzwingt einen sofortigen Status-Refresh (nur Admins)'), 'refresh')
        .toJSON()
    );
  }

  if (enabled.has('help')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('help')
        .setDescription('Zeigt alle verfügbaren Bot-Kommandos'), 'help')
        .toJSON()
    );
  }

  if (enabled.has('coinflip')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('coinflip')
        .setDescription('Wirft eine Münze (Kopf oder Zahl)'), 'coinflip')
        .toJSON()
    );
  }

  if (enabled.has('dice')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('dice')
        .setDescription('Würfelt eine Zahl mit frei wählbaren Seiten')
        .addIntegerOption(opt =>
          applySlashOptionI18n(opt.setName('seiten')
            .setDescription('Anzahl Seiten (2-100, Standard: 6)')
            .setMinValue(2)
            .setMaxValue(100)
            .setRequired(false), {
              names: { 'en-US': 'sides', 'en-GB': 'sides' },
              descriptions: {
                'en-US': 'Number of sides (2-100, default: 6)',
                'en-GB': 'Number of sides (2-100, default: 6)',
              },
            })
        )
        , 'dice')
        .toJSON()
    );
  }

  if (enabled.has('eightball')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('eightball')
        .setDescription('Magische 8-Ball Antwort auf deine Frage')
        .addStringOption(opt =>
          applySlashOptionI18n(opt.setName('frage')
            .setDescription('Deine Frage an den 8-Ball')
            .setRequired(true), {
              names: { 'en-US': 'question', 'en-GB': 'question' },
              descriptions: {
                'en-US': 'Your question for the 8-ball',
                'en-GB': 'Your question for the 8-ball',
              },
            })
        )
        , 'eightball')
        .toJSON()
    );
  }

  if (enabled.has('cleanup')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('cleanup')
        .setDescription('Bereinigt Kanal-Nachrichten anhand der Cleanup-Regeln')
        .addChannelOption(opt =>
          applySlashOptionI18n(opt.setName('kanal')
            .setDescription('Optionaler Zielkanal (Standard: aktueller Kanal)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false), {
              names: { 'en-US': 'channel', 'en-GB': 'channel' },
              descriptions: {
                'en-US': 'Optional target channel (default: current channel)',
                'en-GB': 'Optional target channel (default: current channel)',
              },
            })
        )
        .addIntegerOption(opt =>
          applySlashOptionI18n(opt.setName('max_nachrichten')
            .setDescription('Maximal erlaubte Nachrichten (0 = deaktiviert)')
            .setMinValue(0)
            .setMaxValue(200)
            .setRequired(false), {
              names: { 'en-US': 'max_messages', 'en-GB': 'max_messages' },
              descriptions: {
                'en-US': 'Maximum allowed messages (0 = disabled)',
                'en-GB': 'Maximum allowed messages (0 = disabled)',
              },
            })
        )
        .addIntegerOption(opt =>
          applySlashOptionI18n(opt.setName('max_alter_stunden')
            .setDescription('Nachrichten älter als X Stunden löschen (0 = deaktiviert)')
            .setMinValue(0)
            .setMaxValue(720)
            .setRequired(false), {
              names: { 'en-US': 'max_age_hours', 'en-GB': 'max_age_hours' },
              descriptions: {
                'en-US': 'Delete messages older than X hours (0 = disabled)',
                'en-GB': 'Delete messages older than X hours (0 = disabled)',
              },
            })
        )
        .addBooleanOption(opt =>
          applySlashOptionI18n(opt.setName('nur_bot')
            .setDescription('Nur Bot-Nachrichten löschen')
            .setRequired(false), {
              names: { 'en-US': 'only_bot', 'en-GB': 'only_bot' },
              descriptions: {
                'en-US': 'Delete bot messages only',
                'en-GB': 'Delete bot messages only',
              },
            })
        )
        .addBooleanOption(opt =>
          applySlashOptionI18n(opt.setName('dry_run')
            .setDescription('Nur prüfen, nichts löschen')
            .setRequired(false), {
              descriptions: {
                'en-US': 'Check only, do not delete anything',
                'en-GB': 'Check only, do not delete anything',
              },
            })
        )
        , 'cleanup')
        .toJSON()
    );
  }

  if (enabled.has('translate')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('translate')
        .setDescription('Uebersetzt Text (z. B. Englisch <-> Deutsch)')
        .addStringOption(opt =>
          applySlashOptionI18n(opt.setName('text')
            .setDescription('Zu uebersetzender Text')
            .setRequired(true), {
              descriptions: {
                'en-US': 'Text to translate',
                'en-GB': 'Text to translate',
              },
            })
        )
        .addStringOption(opt =>
          applySlashOptionI18n(opt.setName('ziel')
            .setDescription('Zielsprache, z. B. de, en, fr (leer = Standard)')
            .setRequired(false), {
              names: { 'en-US': 'target', 'en-GB': 'target' },
              descriptions: {
                'en-US': 'Target language, for example de, en, fr (empty = default)',
                'en-GB': 'Target language, for example de, en, fr (empty = default)',
              },
            })
        )
        .addStringOption(opt =>
          applySlashOptionI18n(opt.setName('quelle')
            .setDescription('Quellsprache, z. B. auto, en, de (leer = Standard)')
            .setRequired(false), {
              names: { 'en-US': 'source', 'en-GB': 'source' },
              descriptions: {
                'en-US': 'Source language, for example auto, en, de (empty = default)',
                'en-GB': 'Source language, for example auto, en, de (empty = default)',
              },
            })
        )
        , 'translate')
        .toJSON()
    );
  }

  if (enabled.has('ping')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Zeigt die aktuelle Bot-Latenz'), 'ping')
        .toJSON()
    );
  }

  if (enabled.has('botinfo')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('botinfo')
        .setDescription('Zeigt technische Informationen über den Bot'), 'botinfo')
        .toJSON()
    );
  }

  if (enabled.has('serverstatus')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('serverstatus')
        .setDescription('Zeigt den Status eines einzelnen Dienstes oder einer Gruppe')
        .addStringOption(opt =>
          applySlashOptionI18n(opt.setName('dienst')
            .setDescription('Name oder ID des Dienstes')
            .setRequired(false), {
              names: { 'en-US': 'service', 'en-GB': 'service' },
              descriptions: {
                'en-US': 'Service name or ID',
                'en-GB': 'Service name or ID',
              },
            })
        )
        .addStringOption(opt =>
          applySlashOptionI18n(opt.setName('gruppe')
            .setDescription('Optionaler Gruppenname')
            .setRequired(false), {
              names: { 'en-US': 'group', 'en-GB': 'group' },
              descriptions: {
                'en-US': 'Optional group name',
                'en-GB': 'Optional group name',
              },
            })
        )
        , 'serverstatus')
        .toJSON()
    );
  }

  if (enabled.has('ki')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('ki')
        .setDescription('Stellt dem KI-Chatbot direkt eine Frage')
        .addStringOption(opt =>
          applySlashOptionI18n(opt.setName('frage')
            .setDescription('Deine Frage an den Bot')
            .setRequired(true), {
              names: { 'en-US': 'question', 'en-GB': 'question' },
              descriptions: {
                'en-US': 'Your question for the bot',
                'en-GB': 'Your question for the bot',
              },
            })
        )
        , 'ki')
        .toJSON()
    );
  }

  if (enabled.has('wetter')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('wetter')
        .setDescription('Zeigt das aktuelle Wetter für einen Ort')
        .addStringOption(opt =>
          applySlashOptionI18n(opt.setName('ort')
            .setDescription('Ort, z. B. Berlin')
            .setRequired(true), {
              names: { 'en-US': 'location', 'en-GB': 'location' },
              descriptions: {
                'en-US': 'Location, for example Berlin',
                'en-GB': 'Location, for example Berlin',
              },
            })
        )
        , 'wetter')
        .toJSON()
    );
  }

  if (enabled.has('subscribe')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('subscribe')
        .setDescription('Abonniert Statusänderungen für einen Dienst oder listet deine Abos')
        .addStringOption(opt =>
          applySlashOptionI18n(opt.setName('dienst')
            .setDescription('Dienstname oder ID; leer = aktuelle Abos anzeigen')
            .setRequired(false), {
              names: { 'en-US': 'service', 'en-GB': 'service' },
              descriptions: {
                'en-US': 'Service name or ID; empty = show your subscriptions',
                'en-GB': 'Service name or ID; empty = show your subscriptions',
              },
            })
        )
        , 'subscribe')
        .toJSON()
    );
  }

  if (enabled.has('remind')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('remind')
        .setDescription('Setzt eine Erinnerung')
        .addStringOption(opt =>
          applySlashOptionI18n(opt.setName('zeit')
            .setDescription('Zeit bis zur Erinnerung, z. B. 10m, 2h oder 1d')
            .setRequired(true), {
              names: { 'en-US': 'time', 'en-GB': 'time' },
              descriptions: {
                'en-US': 'Reminder delay, for example 10m, 2h or 1d',
                'en-GB': 'Reminder delay, for example 10m, 2h or 1d',
              },
            })
        )
        .addStringOption(opt =>
          applySlashOptionI18n(opt.setName('text')
            .setDescription('Woran soll erinnert werden?')
            .setRequired(true), {
              descriptions: {
                'en-US': 'What should I remind you about?',
                'en-GB': 'What should I remind you about?',
              },
            })
        )
        , 'remind')
        .toJSON()
    );
  }

  if (enabled.has('quote')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('quote')
        .setDescription('Speichert ein Zitat oder zeigt ein zufälliges an')
        .addStringOption(opt =>
          applySlashOptionI18n(opt.setName('text')
            .setDescription('Zitattext; leer = zufälliges Zitat anzeigen')
            .setRequired(false), {
              descriptions: {
                'en-US': 'Quote text; empty = show a random quote',
                'en-GB': 'Quote text; empty = show a random quote',
              },
            })
        )
        , 'quote')
        .toJSON()
    );
  }

  if (enabled.has('poll')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Erstellt eine einfache Umfrage mit Reaktionen')
        .addStringOption(opt => applySlashOptionI18n(opt.setName('frage').setDescription('Frage der Umfrage').setRequired(true), {
          names: { 'en-US': 'question', 'en-GB': 'question' },
          descriptions: { 'en-US': 'Poll question', 'en-GB': 'Poll question' },
        }))
        .addStringOption(opt => opt.setName('option1').setDescription('Option 1').setRequired(true))
        .addStringOption(opt => opt.setName('option2').setDescription('Option 2').setRequired(true))
        .addStringOption(opt => opt.setName('option3').setDescription('Option 3').setRequired(false))
        .addStringOption(opt => opt.setName('option4').setDescription('Option 4').setRequired(false))
        .addStringOption(opt => opt.setName('option5').setDescription('Option 5').setRequired(false))
        , 'poll')
        .toJSON()
    );
  }

  if (enabled.has('avatar')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('avatar')
        .setDescription('Zeigt den Avatar eines Nutzers')
        .addUserOption(opt =>
          applySlashOptionI18n(opt.setName('nutzer')
            .setDescription('Optionaler Zielnutzer')
            .setRequired(false), {
              names: { 'en-US': 'user', 'en-GB': 'user' },
              descriptions: {
                'en-US': 'Optional target user',
                'en-GB': 'Optional target user',
              },
            })
        )
        , 'avatar')
        .toJSON()
    );
  }

  if (enabled.has('userinfo')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('userinfo')
        .setDescription('Zeigt Informationen über einen Nutzer')
        .addUserOption(opt =>
          applySlashOptionI18n(opt.setName('nutzer')
            .setDescription('Optionaler Zielnutzer')
            .setRequired(false), {
              names: { 'en-US': 'user', 'en-GB': 'user' },
              descriptions: {
                'en-US': 'Optional target user',
                'en-GB': 'Optional target user',
              },
            })
        )
        , 'userinfo')
        .toJSON()
    );
  }

  if (enabled.has('testreply')) {
    commands.push(
      applySlashCommandI18n(new SlashCommandBuilder()
        .setName('testreply')
        .setDescription('Testet eine Nachricht gegen Auto-Reply-Regeln (nur Admins, ephemeral)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(opt =>
          applySlashOptionI18n(opt.setName('nachricht')
            .setDescription('Der Text, den du testen möchtest')
            .setRequired(true), {
              names: { 'en-US': 'message', 'en-GB': 'message' },
              descriptions: {
                'en-US': 'The text you want to test against auto-reply rules',
                'en-GB': 'The text you want to test against auto-reply rules',
              },
            })
        )
        , 'testreply')
        .toJSON()
    );
  }

  try {
    const rest = new REST({ version: '10' }).setToken(config.get('discord.token'));

    // Globale Registrierung (kann bei Discord verzögert sichtbar werden).
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });

    // Zusätzliche Guild-Registrierung für sofortige Verfügbarkeit auf dem eigenen Server.
    const guildIds = Array.from(new Set([
      String(config.get('discord.guildId') || '').trim(),
      String(config.get('discord.serviceGuildId') || '').trim(),
    ].filter(Boolean)));

    for (const guildId of guildIds) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
        logger.info(`Slash-Commands für Guild ${guildId} registriert`);
      } catch (guildErr) {
        logger.warn(`Slash-Commands Guild-Registrierung fehlgeschlagen (${guildId}): ${guildErr.message}`);
      }
    }

    logger.info(`Slash-Commands erfolgreich registriert: ${Array.from(enabled).join(', ')}`);
  } catch (err) {
    logger.error(`Slash-Command-Registrierung fehlgeschlagen: ${err.message}`);
  }
}
// #endregion

async function applyConfiguredBotName() {
  const desiredName = String(config.get('discord.botName') || '').trim();
  if (!desiredName) return;
  if (!client.user) return;
  if (client.user.username === desiredName) return;

  try {
    await client.user.setUsername(desiredName);
    logger.info(`Bot-Username aktualisiert: ${desiredName}`);
  } catch (err) {
    // Discord limitiert Username-Änderungen; deshalb nur warnen, kein Abbruch.
    logger.warn(`Bot-Username konnte nicht gesetzt werden: ${err.message}`);
  }
}

let _presenceTimer = null;
let _presenceIndex = 0;

function getConfiguredPresenceEntries() {
  const raw = String(config.get('discord.presenceText') || '').trim();
  const entries = raw
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 15);
  return entries.length ? entries : ['Service Health'];
}

function getPresenceRotateIntervalMs() {
  const raw = Number(config.get('discord.presenceRotateMs'));
  if (!Number.isFinite(raw)) return 90000;
  return Math.max(15000, Math.min(raw, 3600000));
}

function isAutoReactionEnabled() {
  return config.get('discord.autoReactionEnabled') === true;
}

function getConfiguredAutoReactionEmojis() {
  const raw = String(config.get('discord.autoReactionEmojis') || '').trim();
  const entries = raw
    .split(/[;,]/)
    .map(s => s.trim())
    .filter(Boolean);
  return Array.from(new Set(entries)).slice(0, 5);
}

function getConfiguredAutoReactionChannelIds() {
  const raw = String(config.get('discord.autoReactionChannelIds') || '').trim();
  if (!raw) return [];
  return Array.from(new Set(
    raw.split(/[;,]/)
      .map(s => s.trim())
      .filter(id => /^\d+$/.test(id))
  ));
}

function isTranslationEnabled() {
  return config.get('discord.translateEnabled') === true;
}

function getConfiguredTranslateAllowedGuildIds() {
  const raw = String(config.get('discord.translateAllowedGuildIds') || '').trim();
  if (!raw) return [];
  return Array.from(new Set(
    raw.split(/[;,]/)
      .map(s => s.trim())
      .filter(id => /^\d+$/.test(id))
  ));
}

function getConfiguredTranslateSource() {
  const raw = String(config.get('discord.translateDefaultSource') || 'auto').trim().toLowerCase();
  return raw || 'auto';
}

function getConfiguredTranslateTarget() {
  const raw = String(config.get('discord.translateDefaultTarget') || 'de').trim().toLowerCase();
  return raw || 'de';
}

function getConfiguredTranslateMaxTextLength() {
  const raw = Number(config.get('discord.translateMaxTextLength'));
  if (!Number.isFinite(raw)) return 1800;
  return Math.max(64, Math.min(raw, 4000));
}

function isValidLanguageCode(code) {
  if (!code) return false;
  if (code === 'auto') return true;
  return /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(code);
}

function isTranslationAllowedForGuild(guildId) {
  if (!guildId) return true; // DMs sind immer erlaubt
  const allowed = getConfiguredTranslateAllowedGuildIds();
  if (!allowed.length) return true;
  return allowed.includes(guildId);
}

async function translateViaDeepL({ text, source, target }) {
  const useDeepL = config.get('discord.useDeepL');
  const apiKey = String(config.get('discord.deepLApiKey') || '').trim();
  if (!useDeepL || !apiKey) return null;

  const baseUrl = String(config.get('discord.deepLApiUrl') || '').trim() || 'https://api-free.deepl.com';
  const normalTarget = String(target || 'de').toUpperCase(); // DeepL: uppercase codes + optional -US suffix
  const normalSource = source && source !== 'auto' ? String(source).toUpperCase() : 'AUTO';

  const body = {
    text: text,
    source_lang: normalSource,
    target_lang: normalTarget
  };

  const resp = await axios.post(`${baseUrl}/v2/translate`, body, {
    timeout: 15000,
    headers: {
      'Authorization': `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/json'
    },
    validateStatus: () => true
  });

  if (resp.status < 200 || resp.status >= 300) {
    const msg = resp.data?.message || JSON.stringify(resp.data);
    logger.warn(`DeepL Fallback: ${resp.status} ${msg.slice(0, 100)}`);
    return null; // Fallback zu LibreTranslate
  }

  const translated = resp.data?.translations?.[0]?.text;
  if (translated) return String(translated).trim();
  return null;
}

async function translateViaLibreTranslate({ text, source, target }) {
  let url = String(config.get('discord.translateApiUrl') || '').trim();
  const apiKey = String(config.get('discord.translateApiKey') || '').trim();
  if (!url) throw new Error('DISCORD_TRANSLATE_API_URL ist leer');

  // Sicherheitsnetz: URL muss auf /translate enden
  if (!url.endsWith('/translate')) {
    url = url.replace(/\/+$/, '') + '/translate';
  }

  const body = {
    q: text,
    source,
    target,
    format: 'text'
  };
  if (apiKey) body.api_key = apiKey;

  const resp = await axios.post(url, body, {
    timeout: 15000,
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true
  });

  if (resp.status === 405) {
    throw new Error(`Translate API Fehler (405): Endpunkt akzeptiert kein POST – URL prüfen, muss auf /translate enden (aktuell: ${url})`);
  }

  if (resp.status < 200 || resp.status >= 300) {
    const detail = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || {});
    throw new Error(`Translate API Fehler (${resp.status}): ${detail.slice(0, 220)}`);
  }

  const translated = String(resp.data?.translatedText || '').trim();
  if (!translated) throw new Error('Translate API lieferte keinen translatedText-Wert');
  return translated;
}

async function translateTextViaApi({ text, source, target }) {
  // Versuche zuerst DeepL (wenn aktiviert)
  if (config.get('discord.useDeepL')) {
    try {
      const result = await translateViaDeepL({ text, source, target });
      if (result) return result;
    } catch (e) {
      logger.warn(`DeepL Error: ${e.message}`);
    }
  }
  // Fallback: LibreTranslate
  return await translateViaLibreTranslate({ text, source, target });
}

function applyConfiguredPresenceNow() {
  if (!client.user) return;
  const entries = getConfiguredPresenceEntries();
  const text = entries[_presenceIndex % entries.length] || 'Service Health';
  _presenceIndex = (_presenceIndex + 1) % entries.length;
  client.user.setActivity(text, { type: ActivityType.Watching });
}

function startPresenceRotation() {
  if (_presenceTimer) {
    clearInterval(_presenceTimer);
    _presenceTimer = null;
  }

  _presenceIndex = 0;
  applyConfiguredPresenceNow();

  const intervalMs = getPresenceRotateIntervalMs();
  _presenceTimer = setInterval(() => {
    try {
      applyConfiguredPresenceNow();
    } catch (err) {
      logger.warn(`Discord Presence-Rotation fehlgeschlagen: ${err.message}`);
    }
  }, intervalMs);
}

// #region 21. SLASH-COMMAND HANDLER
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const commandName = resolveCanonicalCommandName(interaction.commandName);
  const interactionLocale = interaction.locale || interaction.guildLocale;
  const enabledSlashCommands = new Set(getEnabledSlashCommands());
  if (!enabledSlashCommands.has(commandName)) {
    return interaction.reply({ content: '❌ Dieses Bot-Kommando ist derzeit deaktiviert.', ephemeral: true });
  }

  if (commandName === 'status') {
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

  if (commandName === 'uptime') {
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

  if (commandName === 'refresh') {
    if (!interaction.memberPermissions?.has('ManageGuild')) {
      return interaction.reply({ content: '\u274C Keine Berechtigung (ManageGuild erforderlich).', ephemeral: true });
    }
    await interaction.reply({ content: '\uD83D\uDD04 Starte manuellen Refresh...', ephemeral: true });
    await updateStatusMessage();
    await interaction.editReply('\u2705 Status-Nachricht wurde aktualisiert.');
  }

  if (commandName === 'help') {
    const germanLocale = isGermanDiscordLocale(interactionLocale);
    const enabledCommands = getEnabledSlashCommands();
    const commandMeta = {
      status:      { cat: 'info', de: 'aktueller Service-Status', en: 'current service status' },
      uptime:      { cat: 'info', de: 'Gesamt-Uptime', en: 'total uptime' },
      refresh:     { cat: 'info', de: 'manueller Refresh (ManageGuild)', en: 'manual refresh (ManageGuild)' },
      cleanup:     { cat: 'info', de: 'Nachrichten-Cleanup (ManageGuild)', en: 'message cleanup (ManageGuild)' },
      translate:   { cat: 'info', de: 'Text übersetzen', en: 'translate text' },
      ping:        { cat: 'info', de: 'Bot-Latenz', en: 'bot latency' },
      botinfo:     { cat: 'info', de: 'technische Bot-Infos', en: 'technical bot info' },
      serverstatus:{ cat: 'info', de: 'einzelner Dienst oder Gruppe', en: 'single service or group' },
      ki:          { cat: 'info', de: 'direkte KI-Frage', en: 'direct AI question' },
      wetter:      { cat: 'info', de: 'Wetter abrufen', en: 'get weather' },
      subscribe:   { cat: 'info', de: 'Status-Abos umschalten/anzeigen', en: 'toggle or list subscriptions' },
      remind:      { cat: 'info', de: 'Erinnerung setzen', en: 'create a reminder' },
      quote:       { cat: 'info', de: 'Zitat speichern oder zufällig anzeigen', en: 'save a quote or show a random one' },
      poll:        { cat: 'info', de: 'Umfrage erstellen', en: 'create a poll' },
      avatar:      { cat: 'info', de: 'Avatar anzeigen', en: 'show avatar' },
      userinfo:    { cat: 'info', de: 'Nutzerinfos anzeigen', en: 'show user info' },
      help:        { cat: 'info', de: 'diese Hilfe anzeigen', en: 'show this help' },
      testreply:   { cat: 'admin', de: 'Auto-Reply-Regeln testen (ManageGuild)', en: 'test auto-reply rules (ManageGuild)' },
      coinflip:    { cat: 'fun', de: 'Münzwurf', en: 'coin flip' },
      dice:        { cat: 'fun', de: 'Würfel', en: 'roll a die' },
      eightball:   { cat: 'fun', de: 'magische Antwort', en: 'magic answer' },
    };

    const formatCommandLine = (cmd) => {
      const display = getSlashCommandDisplayName(cmd, interactionLocale);
      const meta = commandMeta[cmd];
      const label = germanLocale ? (meta?.de || 'Beschreibung folgt') : (meta?.en || 'Description pending');
      return `/${display} - ${label}`;
    };

    const infoLines = enabledCommands.filter((cmd) => (commandMeta[cmd]?.cat || 'info') === 'info').map(formatCommandLine);
    const funLines = enabledCommands.filter((cmd) => commandMeta[cmd]?.cat === 'fun').map(formatCommandLine);
    const adminLines = enabledCommands.filter((cmd) => commandMeta[cmd]?.cat === 'admin').map(formatCommandLine);

    const description = germanLocale
      ? [
          '**So kommunizierst du mit mir**',
          '- Mit `/help` siehst du alle aktiven Funktionen.',
          '- Für KI-Chat im Kanal: `@Bot <deine Frage>`.',
          '- Für direkte KI-Fragen auch `/ki` nutzbar (falls aktiviert).',
          '- Auto-Replies reagieren auf hinterlegte Trigger-Regeln.',
          '',
          '**Info**',
          ...(infoLines.length ? infoLines : ['Keine Info-Kommandos aktiv.']),
          '',
          '**Fun & Gadgets**',
          ...(funLines.length ? funLines : ['Keine Fun-Kommandos aktiv.']),
          '',
          '**Admin / Debug**',
          ...(adminLines.length ? adminLines : ['Keine Admin-Kommandos aktiv.']),
        ].join('\n')
      : [
          '**How To Talk To Me**',
          '- Use `/help` to see all active features.',
          '- For AI chat in a channel: `@Bot <your question>`.',
          '- You can also use `/ki` for direct AI questions (if enabled).',
          '- Auto-replies react to configured trigger rules.',
          '',
          '**Info**',
          ...(infoLines.length ? infoLines : ['No info commands enabled.']),
          '',
          '**Fun & Gadgets**',
          ...(funLines.length ? funLines : ['No fun commands enabled.']),
          '',
          '**Admin / Debug**',
          ...(adminLines.length ? adminLines : ['No admin commands enabled.']),
        ].join('\n');
    return interaction.reply({
      ephemeral: true,
      embeds: [{
        color: 0x5865F2,
        title: germanLocale ? '\u2139\uFE0F Bot-Kommandos' : '\u2139\uFE0F Bot Commands',
        description,
        timestamp: new Date().toISOString()
      }]
    });
  }

  if (commandName === 'translate') {
    if (!isTranslationEnabled()) {
      return interaction.reply({ content: '❌ Uebersetzer ist aktuell deaktiviert.', ephemeral: true });
    }
    if (!isTranslationAllowedForGuild(interaction.guildId || null)) {
      return interaction.reply({ content: '❌ Uebersetzer ist in dieser Guild nicht freigegeben.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      const rawText = String(getSlashStringOption(interaction, 'translate', 'text') || '').trim();
      const maxLen = getConfiguredTranslateMaxTextLength();
      if (!rawText) return interaction.editReply('❌ Bitte gib einen Text an.');
      if (rawText.length > maxLen) {
        return interaction.editReply(`❌ Text zu lang (${rawText.length}/${maxLen}).`);
      }

      const sourceInput = String(getSlashStringOption(interaction, 'translate', 'quelle') || '').trim().toLowerCase();
      const targetInput = String(getSlashStringOption(interaction, 'translate', 'ziel') || '').trim().toLowerCase();
      const source = sourceInput || getConfiguredTranslateSource();
      const target = targetInput || getConfiguredTranslateTarget();

      if (!isValidLanguageCode(source)) {
        return interaction.editReply('❌ Ungueltige Quellsprache. Erlaubt: auto oder Sprachcode wie en, de, fr.');
      }
      if (!isValidLanguageCode(target) || target === 'auto') {
        return interaction.editReply('❌ Ungueltige Zielsprache. Bitte Sprachcode wie de, en oder fr verwenden.');
      }
      if (source !== 'auto' && source === target) {
        return interaction.editReply('⚠️ Quelle und Ziel sind identisch. Bitte unterschiedliche Sprachen waehlen.');
      }

      const translated = await translateTextViaApi({ text: rawText, source, target });
      return interaction.editReply({
        embeds: [{
          color: 0x388bfd,
          title: '🌍 Uebersetzung',
          fields: [
            { name: `Original (${source})`, value: rawText.slice(0, 1024) },
            { name: `Uebersetzt (${target})`, value: translated.slice(0, 1024) }
          ],
          footer: { text: `Quelle: ${interaction.guildId ? 'Server' : 'DM'} · Max-Laenge ${maxLen}` },
          timestamp: new Date().toISOString()
        }]
      });
    } catch (err) {
      logger.error(`/translate Fehler: ${err.message}`);
      const msg = String(err?.message || 'Unbekannter Fehler');
      if (/api key|get an api key|visit .*portal\.libretranslate\.com/i.test(msg)) {
        return interaction.editReply('❌ Die Translate-API verlangt einen API-Key. Bitte in der Web-UI bei "Uebersetzer API Key" setzen und neu versuchen.');
      }
      if (/timeout|timed out|econn|enotfound|network/i.test(msg)) {
        return interaction.editReply('❌ Uebersetzung fehlgeschlagen: API nicht erreichbar (Netzwerk/URL/Timeout).');
      }
      return interaction.editReply(`❌ Uebersetzung fehlgeschlagen: ${msg.slice(0, 180)}`);
    }
  }

  if (commandName === 'ping') {
    const gatewayPing = Math.max(0, Math.round(client.ws.ping || 0));
    const latency = Math.max(0, Date.now() - interaction.createdTimestamp);
    return interaction.reply({
      ephemeral: true,
      embeds: [{
        color: 0x57F287,
        title: '🏓 Pong',
        fields: [
          { name: 'Bot-Latenz', value: `${latency} ms`, inline: true },
          { name: 'Gateway-Ping', value: `${gatewayPing} ms`, inline: true },
        ],
        timestamp: new Date().toISOString(),
      }]
    });
  }

  if (commandName === 'botinfo') {
    const mem = process.memoryUsage();
    const providerUrl = String(config.get('openai.baseUrl') || 'https://api.openai.com/v1').trim();
    const providerName = providerUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || 'unbekannt';
    return interaction.reply({
      ephemeral: true,
      embeds: [{
        color: 0x5865F2,
        title: '🤖 Bot-Informationen',
        fields: [
          { name: 'Version', value: pkg.version || 'unbekannt', inline: true },
          { name: 'Laufzeit', value: formatDurationShort(process.uptime() * 1000), inline: true },
          { name: 'Discord Gateway', value: `${Math.round(client.ws.ping || 0)} ms`, inline: true },
          { name: 'RAM', value: `${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`, inline: true },
          { name: 'Server', value: String(client.guilds.cache.size || 0), inline: true },
          { name: 'KI-Modell', value: String(config.get('openai.model') || 'deaktiviert'), inline: true },
          { name: 'KI-Provider', value: providerName, inline: true },
          { name: 'Node.js', value: process.version, inline: true },
        ],
        timestamp: new Date().toISOString(),
      }]
    });
  }

  if (commandName === 'serverstatus') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const monitors = await getMonitorData();
      if (!monitors?.length) return interaction.editReply('❌ Keine Daten von Uptime Kuma erhalten.');

      const serviceQuery = String(getSlashStringOption(interaction, 'serverstatus', 'dienst') || '').trim();
      const groupQuery = String(getSlashStringOption(interaction, 'serverstatus', 'gruppe') || '').trim();

      if (serviceQuery) {
        const monitor = resolveMonitorByQuery(monitors, serviceQuery);
        if (!monitor) return interaction.editReply(`❌ Kein Dienst gefunden für: ${serviceQuery}`);
        const statusIcon = monitor.status === 1 ? '🟢' : monitor.status === 0 ? '🔴' : '🟡';
        return interaction.editReply({
          embeds: [{
            color: monitor.status === 1 ? 0x43B581 : monitor.status === 0 ? 0xF04747 : 0xFAA61A,
            title: `${statusIcon} ${monitor.name}`,
            fields: [
              { name: 'Gruppe', value: monitor.group || 'General', inline: true },
              { name: 'Status', value: monitor.status === 1 ? 'Online' : monitor.status === 0 ? 'Offline' : 'Pending', inline: true },
              { name: 'Uptime', value: `${monitor.uptime}%`, inline: true },
              { name: 'Ping', value: monitor.ping != null ? `${monitor.ping} ms` : '–', inline: true },
              { name: 'Zuletzt geprüft', value: monitor.time ? new Date(monitor.time).toLocaleString('de-DE') : '–', inline: true },
              { name: 'ID', value: String(monitor.id), inline: true },
            ],
            timestamp: new Date().toISOString(),
          }]
        });
      }

      let filtered = monitors;
      if (groupQuery) {
        const needle = groupQuery.toLowerCase();
        filtered = monitors.filter((monitor) => String(monitor.group || '').toLowerCase().includes(needle));
      }
      if (!filtered.length) return interaction.editReply(`❌ Keine Dienste für die Gruppe gefunden: ${groupQuery}`);

      const lines = filtered
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'de'))
        .map((monitor) => `${monitor.status === 1 ? '🟢' : monitor.status === 0 ? '🔴' : '🟡'} **${monitor.name}** · ${monitor.uptime}% · ${monitor.ping != null ? `${monitor.ping} ms` : '–'}`)
        .slice(0, 20);
      const titleSuffix = groupQuery ? ` (${groupQuery})` : '';
      return interaction.editReply({
        embeds: [{
          color: 0x5865F2,
          title: `📋 Dienststatus${titleSuffix}`,
          description: lines.join('\n'),
          footer: { text: `${filtered.length} Dienst(e)` },
          timestamp: new Date().toISOString(),
        }]
      });
    } catch (err) {
      logger.error(`/serverstatus Fehler: ${err.message}`);
      return interaction.editReply('❌ Fehler beim Abrufen des Dienststatus.');
    }
  }

  if (commandName === 'ki') {
    if (!config.get('openai.enabled')) {
      return interaction.reply({ content: '❌ KI-Chat ist aktuell deaktiviert.', ephemeral: true });
    }
    if (!interaction.guildId && !config.get('openai.allowDMs')) {
      return interaction.reply({ content: '❌ KI-Chat ist per DM deaktiviert.', ephemeral: true });
    }
    if (interaction.guildId) {
      const allowed = _getChatAllowedChannelIds();
      if (allowed.length && !allowed.includes(interaction.channelId)) {
        return interaction.reply({ content: '❌ KI-Chat ist in diesem Kanal nicht freigegeben.', ephemeral: true });
      }
    }

    const question = String(getSlashStringOption(interaction, 'ki', 'frage') || '').trim();
    if (!question) return interaction.reply({ content: '❌ Bitte gib eine Frage an.', ephemeral: true });

    const now = Date.now();
    const rateLimit = Math.max(1, config.get('openai.rateLimitPerMinute') || 5);
    const history = (_chatRateLimitMap.get(interaction.user.id) || []).filter((timestamp) => now - timestamp < 60000);
    if (history.length >= rateLimit) {
      return interaction.reply({ content: `⏳ Langsam! Du kannst maximal ${rateLimit} Anfragen pro Minute stellen.`, ephemeral: true });
    }
    history.push(now);
    _chatRateLimitMap.set(interaction.user.id, history);

    await interaction.deferReply();
    try {
      const reply = await _askOpenAI(question, interaction.member?.displayName || interaction.user.username);
      if (!reply) return interaction.editReply('🤔 Ich konnte gerade keine Antwort generieren. Bitte versuche es später nochmal.');
      return interaction.editReply(reply.length > 1900 ? `${reply.slice(0, 1897)}…` : reply);
    } catch (err) {
      logger.warn(`/ki Fehler für ${interaction.user.tag}: ${err.message}`);
      if (err.response?.status === 401) return interaction.editReply('🔑 API-Key ungültig. Bitte im Dashboard prüfen.');
      if (err.response?.status === 429) return interaction.editReply('⚡ Rate-Limit erreicht. Bitte kurz warten.');
      return interaction.editReply('❌ KI-Chat momentan nicht verfügbar.');
    }
  }

  if (commandName === 'wetter') {
    const location = String(getSlashStringOption(interaction, 'wetter', 'ort') || '').trim();
    if (!location) return interaction.reply({ content: '❌ Bitte gib einen Ort an.', ephemeral: true });
    await interaction.deferReply();
    const weather = await _fetchWeather(location);
    return interaction.editReply(weather || `❌ Für ${location} konnte kein Wetter abgerufen werden.`);
  }

  if (commandName === 'subscribe') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const monitors = await getMonitorData();
      if (!monitors?.length) return interaction.editReply('❌ Keine Daten von Uptime Kuma erhalten.');

      const serviceQuery = String(getSlashStringOption(interaction, 'subscribe', 'dienst') || '').trim();
      if (!serviceQuery) {
        const subscribedIds = getSubscriptionsForUser(interaction.user.id);
        if (!subscribedIds.length) return interaction.editReply('ℹ️ Du hast aktuell keine Dienst-Abos.');
        const subscribedNames = subscribedIds.map((monitorId) => {
          const monitor = monitors.find((entry) => String(entry.id) === String(monitorId));
          return monitor ? `• ${monitor.name}` : `• Dienst ${monitorId}`;
        });
        return interaction.editReply(`🔔 Deine Abos:\n${subscribedNames.join('\n')}`);
      }

      const monitor = resolveMonitorByQuery(monitors, serviceQuery);
      if (!monitor) return interaction.editReply(`❌ Kein Dienst gefunden für: ${serviceQuery}`);

      const subscribed = toggleMonitorSubscription(monitor.id, interaction.user.id);
      return interaction.editReply(subscribed
        ? `✅ Du erhältst jetzt Benachrichtigungen für **${monitor.name}**.`
        : `🛑 Abo für **${monitor.name}** entfernt.`);
    } catch (err) {
      logger.error(`/subscribe Fehler: ${err.message}`);
      return interaction.editReply('❌ Abo konnte nicht verarbeitet werden.');
    }
  }

  if (commandName === 'remind') {
    const durationInput = String(getSlashStringOption(interaction, 'remind', 'zeit') || '').trim();
    const reminderText = String(getSlashStringOption(interaction, 'remind', 'text') || '').trim();
    const durationMs = parseDurationInput(durationInput);
    if (!durationMs || durationMs > 30 * 24 * 60 * 60 * 1000) {
      return interaction.reply({ content: '❌ Ungültige Zeit. Erlaubt sind z. B. 10m, 2h, 1d oder 1w (max. 30 Tage).', ephemeral: true });
    }
    if (!reminderText) return interaction.reply({ content: '❌ Bitte gib einen Erinnerungstext an.', ephemeral: true });

    const remindAt = Date.now() + durationMs;
    addReminder({
      userId: interaction.user.id,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      message: reminderText,
      remindAt,
    });
    return interaction.reply({
      content: `⏰ Erinnerung gesetzt für ${new Date(remindAt).toLocaleString('de-DE')} (${formatDurationShort(durationMs)}).`,
      ephemeral: true,
    });
  }

  if (commandName === 'quote') {
    const quoteText = String(getSlashStringOption(interaction, 'quote', 'text') || '').trim();
    if (quoteText) {
      const entry = addQuoteEntry({
        guildId: interaction.guildId,
        text: quoteText,
        authorId: interaction.user.id,
        authorName: interaction.user.username,
        addedById: interaction.user.id,
      });
      return interaction.reply({ content: `💾 Zitat #${entry.id} gespeichert.`, ephemeral: true });
    }

    const entry = pickRandomQuote(interaction.guildId);
    if (!entry) return interaction.reply({ content: '❌ Noch keine Zitate gespeichert.', ephemeral: true });
    return interaction.reply({
      embeds: [{
        color: 0xF1C40F,
        title: `💬 Zitat #${entry.id}`,
        description: entry.text.slice(0, 4096),
        footer: { text: `Gespeichert von ${entry.authorName || 'unbekannt'} am ${new Date(entry.addedAt).toLocaleString('de-DE')}` },
      }]
    });
  }

  if (commandName === 'poll') {
    const question = String(getSlashStringOption(interaction, 'poll', 'frage') || '').trim();
    const options = ['option1', 'option2', 'option3', 'option4', 'option5']
      .map((key) => String(getSlashStringOption(interaction, 'poll', key) || '').trim())
      .filter(Boolean)
      .slice(0, 5);
    if (!question || options.length < 2) {
      return interaction.reply({ content: '❌ Bitte gib eine Frage und mindestens zwei Optionen an.', ephemeral: true });
    }

    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
    await interaction.reply({
      embeds: [{
        color: 0x5865F2,
        title: '📊 Umfrage',
        description: [`**${question}**`, '', ...options.map((option, index) => `${emojis[index]} ${option}`)].join('\n'),
        footer: { text: `Erstellt von ${interaction.user.username}` },
        timestamp: new Date().toISOString(),
      }]
    });
    const reply = await interaction.fetchReply();
    for (let index = 0; index < options.length; index++) {
      await reply.react(emojis[index]).catch(() => {});
    }
    return;
  }

  if (commandName === 'avatar') {
    const targetUser = getSlashUserOption(interaction, 'avatar', 'nutzer') || interaction.user;
    return interaction.reply({
      embeds: [{
        color: 0x5865F2,
        title: `🖼️ Avatar von ${targetUser.username}`,
        image: { url: targetUser.displayAvatarURL({ size: 1024, extension: 'png' }) },
      }],
      ephemeral: true,
    });
  }

  if (commandName === 'userinfo') {
    const targetUser = getSlashUserOption(interaction, 'userinfo', 'nutzer') || interaction.user;
    const member = interaction.guild?.members?.cache?.get(targetUser.id) || interaction.options.getMember('nutzer') || null;
    return interaction.reply({
      embeds: [{
        color: 0x5865F2,
        title: `👤 ${targetUser.username}`,
        thumbnail: { url: targetUser.displayAvatarURL({ size: 256, extension: 'png' }) },
        fields: [
          { name: 'ID', value: targetUser.id, inline: true },
          { name: 'Bot', value: targetUser.bot ? 'Ja' : 'Nein', inline: true },
          { name: 'Account erstellt', value: new Date(targetUser.createdTimestamp).toLocaleString('de-DE'), inline: false },
          { name: 'Server beigetreten', value: member?.joinedTimestamp ? new Date(member.joinedTimestamp).toLocaleString('de-DE') : '–', inline: false },
        ],
      }],
      ephemeral: true,
    });
  }

  if (commandName === 'coinflip') {
    const result = Math.random() < 0.5 ? 'Kopf \uD83E\uDE99' : 'Zahl \uD83D\uDCB0';
    return interaction.reply({ content: `\uD83E\uDE99 Münzwurf: **${result}**`, ephemeral: true });
  }

  if (commandName === 'dice') {
    const sides = getSlashIntegerOption(interaction, 'dice', 'seiten') || 6;
    const roll = Math.floor(Math.random() * sides) + 1;
    return interaction.reply({ content: `\uD83C\uDFB2 d${sides}: **${roll}**`, ephemeral: true });
  }

  if (commandName === 'eightball') {
    const question = String(getSlashStringOption(interaction, 'eightball', 'frage') || '').trim();
    if (!question) return interaction.reply({ content: '❌ Bitte gib eine Frage an.', ephemeral: true });
    const answers = [
      'Ja, eindeutig.',
      'Sieht gut aus.',
      'Sehr wahrscheinlich.',
      'Antwort unklar, frag später nochmal.',
      'Lieber nicht.',
      'Eher nein.',
      'Auf keinen Fall.',
      'Die Sterne sagen: vielleicht.',
    ];
    const answer = answers[Math.floor(Math.random() * answers.length)];
    return interaction.reply({
      ephemeral: true,
      embeds: [{
        color: 0x9B59B6,
        title: '\uD83C\uDFB1 Magischer 8-Ball',
        fields: [
          { name: 'Frage', value: question.slice(0, 1024) },
          { name: 'Antwort', value: answer },
        ],
      }]
    });
  }

  if (commandName === 'cleanup') {
    if (!interaction.memberPermissions?.has('ManageGuild')) {
      return interaction.reply({ content: '❌ Keine Berechtigung (ManageGuild erforderlich).', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      const targetChannel = getSlashChannelOption(interaction, 'cleanup', 'kanal') || interaction.channel;
      if (!targetChannel || !targetChannel.isTextBased?.()) {
        return interaction.editReply('❌ Bitte einen gültigen Textkanal auswählen.');
      }

      const maxMessages = getSlashIntegerOption(interaction, 'cleanup', 'max_nachrichten');
      const maxAgeHours = getSlashIntegerOption(interaction, 'cleanup', 'max_alter_stunden');
      const onlyBot = getSlashBooleanOption(interaction, 'cleanup', 'nur_bot');
      const dryRun = getSlashBooleanOption(interaction, 'cleanup', 'dry_run') === true;

      const options = getMessageCleanupOptions({
        enabled: true,
        ...(maxMessages !== null ? { maxMessages } : {}),
        ...(maxAgeHours !== null ? { maxAgeHours } : {}),
        ...(onlyBot !== null ? { onlyBotMessages: onlyBot } : {}),
        dryRun,
      });

      if (options.maxMessages === 0 && options.maxAgeHours === 0) {
        return interaction.editReply('⚠️ Keine Regel aktiv: setze `max_nachrichten` oder `max_alter_stunden` größer als 0.');
      }

      const result = await cleanupMessagesInChannel(targetChannel, options);
      const modeText = dryRun ? 'Dry-Run' : 'Live';
      await interaction.editReply(
        `✅ Cleanup (${modeText}) in #${targetChannel.name || targetChannel.id}: `
        + `gescannt=${result.scanned}, kandidaten=${result.candidates}, gelöscht=${result.deleted}, fehler=${result.skipped}`
      );
    } catch (err) {
      logger.error(`/cleanup Fehler: ${err.message}`);
      await interaction.editReply('❌ Cleanup fehlgeschlagen. Details im Bot-Log.');
    }
  }

  if (commandName === 'testreply') {
    if (!interaction.memberPermissions?.has('ManageGuild')) {
      return interaction.reply({ content: '❌ Keine Berechtigung (ManageGuild erforderlich).', ephemeral: true });
    }
    const testText = String(getSlashStringOption(interaction, 'testreply', 'nachricht') || '').trim();
    if (!testText) {
      return interaction.reply({ content: '❌ Bitte eine Testnachricht angeben.', ephemeral: true });
    }

    const gateHints = [];
    if (!config.get('discord.autoReplyEnabled')) {
      gateHints.push('Auto-Reply ist aktuell deaktiviert (`DISCORD_AUTO_REPLY_ENABLED=false`).');
    }
    if (config.get('discord.autoReplyMentionOnly')) {
      gateHints.push('Mention-Only ist aktiv: normale Antworten nur bei @Bot-Erwähnung.');
    }
    const rawAutoReplyChannelIds = String(config.get('discord.autoReplyChannelIds') || '');
    const autoReplyChannelIds = rawAutoReplyChannelIds.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    if (autoReplyChannelIds.length && !autoReplyChannelIds.includes(interaction.channelId)) {
      gateHints.push(`Kanal-Filter aktiv: dieser Kanal (${interaction.channelId}) ist nicht freigegeben.`);
    }

    const rules = typeof _loadAutoReplyRules === 'function' ? _loadAutoReplyRules() : [];
    if (!rules.length) {
      return interaction.reply({ content: '⚠️ Keine Auto-Reply-Regeln konfiguriert.', ephemeral: true });
    }

    let matchedRule = null;
    for (const rule of rules) {
      if (!rule.trigger || !rule.reply) continue;
      const res = _matchAutoReplyRule(testText, rule);
      if (res.error) continue;
      if (res.matched) { matchedRule = rule; break; }
    }

    if (!matchedRule) {
      const nearMiss = rules.find((rule) => {
        if (!rule?.trigger || !rule?.reply || rule.caseSensitive !== true) return false;
        const probeRule = { ...rule, caseSensitive: false };
        const res = _matchAutoReplyRule(testText, probeRule);
        return !!res.matched;
      });
      const hint = nearMiss
        ? `\n\n💡 Hinweis: Regel \`${nearMiss.id || 'ohne-id'}\` ist aktuell auf Groß/Klein-Prüfung gestellt und matcht deshalb hier nicht.`
        : '';
      const gateHintText = gateHints.length
        ? `\n\n⚙️ Live-Blocker:\n- ${gateHints.join('\n- ')}`
        : '';
      return interaction.reply({
        content: `🔍 **Testreply** – kein Treffer\n\n> \`${testText.slice(0, 200)}\`\n\nKeine der ${rules.length} Regel(n) matcht diesen Text.${hint}${gateHintText}`,
        ephemeral: true,
      });
    }

    const modeLabel = matchedRule.mode === 'contains' ? 'Enthält' : matchedRule.mode === 'exact' ? 'Exakt' : 'Regex';
    const gateHintText = gateHints.length
      ? `\n\n⚙️ Live-Blocker:\n- ${gateHints.join('\n- ')}`
      : '';
    return interaction.reply({
      content: gateHintText || undefined,
      embeds: [{
        color: 0x2ECC71,
        title: '✅ Testreply – Treffer gefunden',
        fields: [
          { name: 'Testnachricht', value: `\`${testText.slice(0, 1024)}\`` },
          { name: 'Regel-ID', value: String(matchedRule.id || '–'), inline: true },
          { name: 'Modus', value: `${modeLabel} | ${matchedRule.caseSensitive ? 'Groß/Klein' : 'Case-insensitiv'}`, inline: true },
          { name: 'Trigger', value: `\`${String(matchedRule.trigger).slice(0, 500)}\`` },
          { name: 'Bot-Antwort', value: String(matchedRule.reply).slice(0, 1024) },
        ],
        footer: { text: 'Nur du siehst diese Antwort (ephemeral)' },
      }],
      ephemeral: true,
    });
  }
});
// #endregion

// #region 21.5 KI-CHATBOT (OpenAI + Wetter)
const _chatRateLimitMap = new Map();

function _getChatAllowedChannelIds() {
  const raw = config.get('openai.channelIds') || '';
  return raw.split(/[,;]/).map(s => s.trim()).filter(Boolean);
}

function _escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _getAiNameTriggers() {
  const fromConfig = [String(config.get('openai.personaName') || '').trim(), String(client.user?.username || '').trim()]
    .filter(Boolean);
  return [...new Set(fromConfig.map((v) => v.toLocaleLowerCase('de-DE')))].filter((v) => v.length >= 2);
}

function _messageHasAiNameTrigger(message) {
  if (!config.get('openai.nameTriggerEnabled')) return false;
  const text = String(message?.content || '').normalize('NFC');
  if (!text.trim()) return false;
  const triggers = _getAiNameTriggers();
  return triggers.some((name) => {
    const rx = new RegExp(`(^|[^\\p{L}\\p{N}_])${_escapeRegex(name)}(?=$|[^\\p{L}\\p{N}_])`, 'iu');
    return rx.test(text);
  });
}

async function _fetchWeather(location) {
  try {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=3&lang=de`;
    const res = await axios.get(url, { timeout: 5000, headers: { 'User-Agent': 'BockisDiscordBot/1.0' } });
    const text = (res.data || '').toString().trim();
    if (!text || text.includes('Unknown location')) return null;
    return `🌤️ **Wetter für ${location}**\n\`\`\`${text}\`\`\``;
  } catch {
    return null;
  }
}

async function _askOpenAI(userContent, userName) {
  const apiKey = config.get('openai.apiKey');
  if (!apiKey) return null;
  const baseUrlRaw = (config.get('openai.baseUrl') || 'https://api.openai.com/v1').trim();
  const baseUrl = baseUrlRaw.replace(/\/+$/, '');
  const endpoint = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
  const model = config.get('openai.model') || 'gpt-4o-mini';
  const personaName = config.get('openai.personaName') || 'Bockis';
  const maxTokens = Math.min(2000, Math.max(50, config.get('openai.maxTokens') || 600));
  const customPrompt = config.get('openai.systemPrompt') || '';
  const systemPrompt = customPrompt || (() => {
    const enabledCmds = getEnabledSlashCommands();
    const cmdDesc = {
      status:      'aktuellen Service-Status anzeigen',
      uptime:      'Gesamt-Uptime anzeigen',
      refresh:     'Bot-Status manuell aktualisieren (Admin)',
      cleanup:     'Nachrichten löschen (Admin)',
      translate:   'Text übersetzen',
      ping:        'Bot-Latenz prüfen',
      botinfo:     'technische Bot-Infos anzeigen',
      serverstatus:'einzelnen Dienst oder Gruppe prüfen',
      ki:          'direkte KI-Frage stellen',
      wetter:      'Wetter für einen Ort abrufen',
      subscribe:   'Status-Benachrichtigungen abonnieren/verwalten',
      remind:      'Erinnerungen setzen',
      quote:       'Zitate speichern oder zufällig anzeigen',
      poll:        'Umfragen erstellen',
      avatar:      'Avatar eines Nutzers anzeigen',
      userinfo:    'Nutzerinformationen anzeigen',
      help:        'alle aktiven Bot-Befehle anzeigen (/hilfe)',
      coinflip:    'Münzwurf',
      dice:        'Würfeln mit beliebigen Seiten',
      eightball:   'magische 8-Ball-Antwort',
      testreply:   'Auto-Reply-Regeln testen (Admin)',
    };
    const enabledList = enabledCmds
      .filter(cmd => cmdDesc[cmd])
      .map(cmd => `  /${cmd} — ${cmdDesc[cmd]}`)
      .join('\n');
    const autoReplyOn = (() => { try { return config.get('discord.autoReplyEnabled'); } catch { return false; } })();
    const kiOn = (() => { try { return config.get('openai.enabled'); } catch { return false; } })();
    const featureDetails = [
      autoReplyOn ? [
        `AUTO-REPLY (aktiv): Dieser Bot reagiert automatisch auf Chat-Nachrichten anhand hinterlegter Regeln.`,
        `  - Regeln werden im Web-Dashboard konfiguriert (Stichwörter, Regex oder Enthält-Prüfung).`,
        `  - Jede Regel hat einen Trigger und eine oder mehrere Antworten.`,
        `  - Es gibt fertige Templates: Begrüßung, Gute Nacht, Schönen Abend, Wochenende, Wochentage.`,
        `  - Mit /testreply kann ein Admin prüfen ob eine Nachricht eine Regel auslösen würde.`,
        `  - Cooldown verhindert Spam (Standard: 10 Sekunden pro Nutzer+Kanal).`,
        `  - Einstellbar: nur bei @Erwähnung reagieren, bestimmte Kanäle erlauben.`,
      ].join('\n') : null,
      kiOn ? [
        `KI-CHAT (aktiv): Nutzer können den Bot per @Erwähnung oder /ki direkt befragen.`,
        `  - Der Bot antwortet mit KI-generierten Antworten.`,
        `  - Wetterfragen werden automatisch erkannt und beantwortet.`,
        `  - Rate-Limit schützt vor Missbrauch.`,
        `  - Die Persönlichkeit ist über das Dashboard (System-Prompt) anpassbar.`,
      ].join('\n') : null,
      `DASHBOARD: Das Web-Dashboard ist erreichbar unter http://localhost:3000/dashboard.`,
      `  - Dort können Auto-Reply-Regeln, KI-Einstellungen, Willkommensnachrichten und mehr konfiguriert werden.`,
      `  - Änderungen werden sofort gespeichert, kein Bot-Neustart nötig.`,
    ].filter(Boolean).join('\n\n');
    return (
      `Du bist ${personaName}, ein Discord-Bot auf diesem Server. ` +
      `Antworte immer auf Deutsch, kurz und präzise (maximal 4 Sätze). ` +
      `Du bist humorvoll aber respektvoll. Der Nutzer heißt ${userName}.\n\n` +
      `DEINE VERFÜGBAREN SLASH-BEFEHLE:\n${enabledList || '  (keine aktiv)'}\n\n` +
      `DEINE FEATURES UND WIE SIE FUNKTIONIEREN:\n${featureDetails}\n\n` +
      `Wenn jemand fragt wie eine Funktion funktioniert, erkläre sie anhand der obigen Beschreibung — nicht generisch. ` +
      `Weise bei Bedarf auf /hilfe oder das Dashboard hin.`
    );
  })();

  const res = await axios.post(
    endpoint,
    {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ]
    },
    {
      timeout: 20000,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return res.data?.choices?.[0]?.message?.content?.trim() || null;
}

client.on('messageCreate', async (message) => {
  if (message.author?.bot) return;
  if (message.system) return;

  const isDM = message.channel?.type === ChannelType.DM;
  // Never auto-answer mass mentions in guild channels.
  if (!isDM && message.mentions?.everyone) return;
  const isMention = message.mentions.has(client.user);
  const isNameTrigger = !isDM && _messageHasAiNameTrigger(message);

  // Fallback wenn KI deaktiviert: @Erwähnung trotzdem beantworten
  if (!config.get('openai.enabled')) {
    if (!isDM && (isMention || isNameTrigger)) {
      const q = message.content.replace(/<@!?\d+>/g, '').trim();
      if (q && /\b(hilf|help|hilfe|wie|was kannst|kannst du|erkl[äa]r|was machst|commands|befehle|kommandos)\b/i.test(q)) {
        await message.reply({
          content: '💡 Ich habe keine KI aktiviert, aber ich helfe dir trotzdem:\n' +
            'Mit `/hilfe` siehst du alle aktiven Befehle.\n' +
            'Auto-Reply reagiert auf hinterlegte Stichwörter im Chat. 😊'
        }).catch(() => {});
      } else if (q) {
        await message.reply({
          content: `Hey ${message.author.displayName || message.author.username}! 👋 Schreib \`/hilfe\` um alle meine Funktionen zu sehen.`
        }).catch(() => {});
      }
    }
    return;
  }

  if (!isDM && !isMention && !isNameTrigger) return;
  if (isDM && !config.get('openai.allowDMs')) return;

  // Kanal-Filter (nur bei Guild-Nachrichten)
  if (!isDM) {
    const allowed = _getChatAllowedChannelIds();
    if (allowed.length && !allowed.includes(message.channelId)) return;
  }

  // Rate-Limiting pro Nutzer
  const now = Date.now();
  const rateLimit = Math.max(1, config.get('openai.rateLimitPerMinute') || 5);
  const history = (_chatRateLimitMap.get(message.author.id) || []).filter(t => now - t < 60000);
  if (history.length >= rateLimit) {
    await message.reply({ content: `⏳ Langsam! Du kannst maximal ${rateLimit} Anfragen pro Minute stellen.` }).catch(() => {});
    return;
  }
  history.push(now);
  _chatRateLimitMap.set(message.author.id, history);

  // Mention-Prefix entfernen
  let content = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!isMention && isNameTrigger) {
    const triggerPatterns = _getAiNameTriggers().map((name) => new RegExp(`^\\s*${_escapeRegex(name)}(?:[,:;!?.-]+\\s*|\\s+)`, 'iu'));
    for (const pattern of triggerPatterns) {
      if (pattern.test(content)) {
        content = content.replace(pattern, '').trim();
        break;
      }
    }
  }
  if (!content) {
    await message.reply({ content: `Hey ${message.author.displayName}! Wie kann ich dir helfen? 😊` }).catch(() => {});
    return;
  }

  // Typing-Indikator
  try { await message.channel.sendTyping(); } catch { /* ignorieren */ }

  // Wetter-Erkennung
  if (/\b(wetter|weather|temperatur(?:en)?|regen|schnee|nebel|wind|forecast|wettervorhersage)\b/i.test(content)) {
    const locMatch = content.match(/(?:wetter|weather|in|für|für)\s+([a-zäöüßA-ZÄÖÜ][a-zäöüßA-ZÄÖÜ\s\-]{1,40})/i);
    const location = locMatch ? locMatch[1].trim() : 'Deutschland';
    const weather = await _fetchWeather(location);
    if (weather) {
      await message.reply({ content: weather }).catch(() => {});
      return;
    }
  }

  // OpenAI Anfrage
  try {
    const reply = await _askOpenAI(content, message.author.displayName || message.author.username);
    if (reply) {
      // Discord-Limit: 2000 Zeichen
      const truncated = reply.length > 1900 ? reply.slice(0, 1897) + '…' : reply;
      await message.reply({ content: truncated }).catch(() => {});
    } else {
      await message.reply({ content: '🤔 Ich konnte gerade keine Antwort generieren. Bitte versuche es später nochmal.' }).catch(() => {});
    }
  } catch (err) {
    logger.warn(`KI-Chat Fehler für ${message.author.tag}: ${err.message}`);
    if (err.response?.status === 401) {
      await message.reply({ content: '🔑 OpenAI API-Key ungültig. Bitte im Dashboard prüfen.' }).catch(() => {});
    } else if (err.response?.status === 429) {
      await message.reply({ content: '⚡ OpenAI Rate-Limit erreicht. Bitte kurz warten.' }).catch(() => {});
    } else {
      await message.reply({ content: '❌ KI-Chat momentan nicht verfügbar.' }).catch(() => {});
    }
  }
});
// #endregion

// #region 21.6 AUTO-REPLY
const _autoReplyCooldownMap = new Map();

function _loadAutoReplyRules() {
  try {
    const filePath = path.join(__dirname, config.get('discord.autoReplyRulesFile') || './auto-replies.json');
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const rules = JSON.parse(content);
    return Array.isArray(rules) ? rules : [];
  } catch {
    return [];
  }
}

function _autoReplyMatchTextValue(value, caseSensitive = false) {
  const normalized = String(value ?? '').normalize('NFC');
  return caseSensitive ? normalized : normalized.toLocaleLowerCase('de-DE');
}

function _matchAutoReplyRule(content, rule) {
  const mode = String(rule?.mode || 'contains').trim().toLowerCase();
  const effectiveMode = ['contains', 'exact', 'regex'].includes(mode) ? mode : 'contains';
  const caseSensitive = rule?.caseSensitive === true;
  const trigger = String(rule?.trigger ?? '');
  const text = String(content ?? '');

  try {
    if (effectiveMode === 'regex') {
      const flags = caseSensitive ? 'u' : 'iu';
      return { matched: new RegExp(trigger, flags).test(text), mode: effectiveMode, error: null };
    }

    const a = _autoReplyMatchTextValue(text, caseSensitive);
    const b = _autoReplyMatchTextValue(trigger, caseSensitive);
    if (effectiveMode === 'exact') return { matched: a === b, mode: effectiveMode, error: null };
    return { matched: a.includes(b), mode: effectiveMode, error: null };
  } catch (err) {
    return { matched: false, mode: effectiveMode, error: err };
  }
}

async function _processAutoReplyMessage(message) {
  if (!config.get('discord.autoReplyEnabled')) return;
  if (message.author?.bot) return;
  if (message.system) return;
  if (!message.inGuild()) return;

  // Kanal-Filter
  const rawChannelIds = config.get('discord.autoReplyChannelIds') || '';
  const allowedChannelIds = rawChannelIds.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  if (allowedChannelIds.length && !allowedChannelIds.includes(message.channelId)) return;

  // Mention-Only Modus
  if (config.get('discord.autoReplyMentionOnly') && !message.mentions.has(client.user)) return;

  // Cooldown-Prüfung pro Nutzer+Kanal
  const cooldownMs = Math.max(0, config.get('discord.autoReplyCooldownMs') || 30000);
  const cooldownKey = `${message.author.id}:${message.channelId}`;
  const lastReply = _autoReplyCooldownMap.get(cooldownKey) || 0;
  if (cooldownMs > 0 && Date.now() - lastReply < cooldownMs) return;

  const rules = _loadAutoReplyRules();
  if (!rules.length) return;

  const content = message.content;
  const matchedReplies = [];

  for (const rule of rules) {
    if (!rule.trigger || !rule.reply) continue;
    const res = _matchAutoReplyRule(content, rule);
    if (res.error) {
      const modeHint = String(rule.mode || 'contains');
      logger.warn(`Auto-Reply Regel-Fehler (Regel ${rule.id || 'ohne-id'}, Modus ${modeHint}): ${res.error.message}`);
      continue;
    }

    if (res.matched) {
      matchedReplies.push(String(rule.reply));
    }
  }

  if (!matchedReplies.length) return;

  // Duplikate entfernen und Reply-Flut begrenzen.
  const uniqueReplies = [...new Set(matchedReplies.map((v) => String(v || '').trim()).filter(Boolean))];
  const repliesToSend = uniqueReplies.slice(0, 5);

  _autoReplyCooldownMap.set(cooldownKey, Date.now());
  for (const replyText of repliesToSend) {
    try {
      const safeReply = replyText.length > 1900 ? replyText.slice(0, 1897) + '…' : replyText;
      await message.reply({ content: safeReply });
    } catch (err) {
      logger.warn(`Auto-Reply fehlgeschlagen: ${err.message}`);
    }
  }
}

client.on('messageCreate', async (message) => {
  await _processAutoReplyMessage(message);
});

client.on('messageUpdate', async (_oldMessage, newMessage) => {
  try {
    const message = newMessage?.partial ? await newMessage.fetch() : newMessage;
    if (!message || typeof message.content !== 'string') return;
    if (!message.content.trim()) return;
    await _processAutoReplyMessage(message);
  } catch {
    // Ignore fetch/update edge cases quietly.
  }
});
// #endregion

client.on('messageCreate', async (message) => {
  if (!isAutoReactionEnabled()) return;
  if (!message.inGuild()) return;
  if (message.author?.bot) return;
  if (message.system) return;
  if (!message.channel || message.channel.type !== ChannelType.GuildText) return;

  const allowedChannelIds = getConfiguredAutoReactionChannelIds();
  if (allowedChannelIds.length && !allowedChannelIds.includes(message.channelId)) return;

  const emojis = getConfiguredAutoReactionEmojis();
  if (!emojis.length) return;

  for (const emoji of emojis) {
    try {
      await message.react(emoji);
    } catch (err) {
      logger.warn(`Auto-Reaction fehlgeschlagen in #${message.channel?.name || message.channelId} mit ${emoji}: ${err.message}`);
    }
  }
});

// #region 22. UPDATE-ZYKLUS
function initializeCleanupTimers() {
  const globalIntervalMs = Math.max(60_000, _toNonNegativeInt(config.get('discord.messageCleanupIntervalMs'), 300000));
  const channels = getMessageCleanupChannels();

  if (!channels.length) {
    // Kein Kanal konfiguriert – globaler Fallback (nutzt DISCORD_NOTIFICATION_CHANNEL falls gesetzt)
    runConfiguredMessageCleanup();
    setInterval(runConfiguredMessageCleanup, globalIntervalMs);
    return;
  }

  // Kanäle nach ihrem effektiven Intervall gruppieren und separate Timer erstellen
  const byInterval = new Map();
  for (const ch of channels) {
    const ms = Math.max(60_000, ch.overrides.cleanupIntervalMs ?? globalIntervalMs);
    if (!byInterval.has(ms)) byInterval.set(ms, []);
    byInterval.get(ms).push(ch);
  }

  for (const [ms, group] of byInterval) {
    const runGroup = async () => {
      const globalOptions = getMessageCleanupOptions();
      if (!globalOptions.enabled) return;
      for (const { id: channelId, overrides } of group) {
        const channelOptions = Object.assign({}, globalOptions, overrides);
        let channel = client.channels.cache.get(channelId);
        if (!channel) {
          try {
            channel = await client.channels.fetch(channelId);
          } catch (err) {
            logger.warn(`Nachrichten-Cleanup: Kanal ${channelId} konnte nicht geladen werden: ${err.message}`);
            continue;
          }
        }
        const result = await cleanupMessagesInChannel(channel, channelOptions);
        if (result.deleted > 0 || result.skipped > 0) {
          logger.info(`Nachrichten-Cleanup: #${channel.name || channel.id} gescannt=${result.scanned} kandidat=${result.candidates} gelöscht=${result.deleted} fehler=${result.skipped}`);
        }
      }
    };
    runGroup();
    setInterval(runGroup, ms);
  }
}

function initializeUpdateCycle() {
  const interval = config.get('checkIntervalMs');
  logger.info(`Update-Zyklus gestartet (alle ${interval / 1000}s)`);
  updateStatusMessage();
  setInterval(updateStatusMessage, interval);
  initializeCleanupTimers();
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
  await applyConfiguredBotName();
  startPresenceRotation();
  await registerSlashCommands();
  reschedulePendingReminders();
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
