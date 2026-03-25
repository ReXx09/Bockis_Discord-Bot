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
const { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
const winston = require('winston');
require('winston-daily-rotate-file');
const express = require('express');
const prom = require('prom-client');
const { Sequelize, DataTypes, Op } = require('sequelize');
const fs = require('fs');

// ── 1. ENV-VALIDIERUNG ────────────────────────────────────────────────────────
const REQUIRED_ENV = ['DISCORD_TOKEN', 'STATUS_CHANNEL_ID', 'UPTIME_KUMA_URL'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error(`[FATAL] Fehlende Umgebungsvariablen: ${missingEnv.join(', ')}\nBitte .env prüfen.`);
  process.exit(1);
}

// ── 2. LOGGER MIT LOG-ROTATION ────────────────────────────────────────────────
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

// ── 3. KONFIGURATION ──────────────────────────────────────────────────────────
const config = require('./config/config');

// ── 4. DATENBANK-INITIALISIERUNG ──────────────────────────────────────────────
const sequelize = new Sequelize(config.get('database'));
const MonitorStatus = require('./models/MonitorStatus')(sequelize, DataTypes);

// ── 5. PROMETHEUS METRIKEN ────────────────────────────────────────────────────
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

// ── 6. EXPRESS DASHBOARD ──────────────────────────────────────────────────────
const app = express();
app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.static('public'));

// ── 7. MIDDLEWARE ─────────────────────────────────────────────────────────────
// Redirect: / → /dashboard
app.get('/', (req, res) => res.redirect('/dashboard'));
function localOnly(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  return res.status(403).json({ error: 'Forbidden' });
}

function dashboardAuth(req, res, next) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return next();
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [, pwd] = Buffer.from(b64auth, 'base64').toString().split(':');
  if (pwd && pwd === password) return next();
  res.set('WWW-Authenticate', 'Basic realm="Service Dashboard"');
  return res.status(401).send('Authentifizierung erforderlich');
}

// ── 8. SERVICE-STATUS THEME ───────────────────────────────────────────────────
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

// ── 9. NOTIFICATION MANAGER ───────────────────────────────────────────────────
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

// ── 10. DISCORD CLIENT ────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});
const notificationManager = new NotificationManager();

// ── 11. STATE PERSISTENZ ──────────────────────────────────────────────────────
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

// ── 12. RATE-LIMIT SCHUTZ ─────────────────────────────────────────────────────
let lastEditTimestamp = 0;
const MIN_EDIT_INTERVAL_MS        = 5_000;
const MIN_CHANNEL_RENAME_MS       = 6 * 60 * 1000;  // 6 min sicherer Puffer (Discord: max 2/10min)
const CHANNEL_INDICATOR_ENABLED   = process.env.CHANNEL_STATUS_INDICATOR !== 'false';
const STATUS_DOT = { green: '🟢', yellow: '🟡', red: '🔴' };

// ── 13. RETRY-LOGIK ───────────────────────────────────────────────────────────
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

// ── 14. UPTIME KUMA API HELPER ────────────────────────────────────────────────
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

// ── 15. MONITOR-DATEN ABRUFEN ─────────────────────────────────────────────────
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

// ── 16. EMBED-GENERIERUNG ─────────────────────────────────────────────────────
function createServiceField(monitor) {
  const status = !monitor.active ? 'deactivated' :
    monitor.status === 1 ? 'online' :
    monitor.status === 0 ? 'offline' :
    monitor.status === 2 ? 'pending' : 'maintenance';

  const theme = STATUS_THEME[status];
  const barFilled = Math.round(monitor.uptime / 10);
  const bar = '▰'.repeat(barFilled) + '▱'.repeat(10 - barFilled);
  const timeStr = new Date(monitor.time)
    .toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return {
    name: `${theme.icon}  ${monitor.name}`,
    value: `**${theme.title}** \`${bar}\` **${monitor.uptime}%** · \`${timeStr}\``,
    inline: false   // ← kein 3-Spalten-Raster mehr
  };
}

// ── 17a. CHANNEL-INDIKATOR (Name + Topic) ────────────────────────────────────
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
  if (!CHANNEL_INDICATOR_ENABLED) return;

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
    saveState({ statusMessageId, lastChannelStatus, lastChannelNameMs });
    logger.info(`Channel-Indikator: ${channel.name} → ${newName} | ${newTopic}`);
  } catch (err) {
    logger.error(`Channel-Indikator fehlgeschlagen: ${err.message}`);
  }
}

// ── 17. DISCORD STATUS-NACHRICHT ──────────────────────────────────────────────
async function updateStatusMessage() {
  const now = Date.now();
  if (now - lastEditTimestamp < MIN_EDIT_INTERVAL_MS) {
    logger.warn('Rate-Limit-Schutz: Update übersprungen (zu schnell aufgerufen)');
    return;
  }

  const channelId = config.get('discord.statusChannelId');
  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    logger.error('Ung\u00fcltige discord.statusChannelId \u2013 Channel nicht gefunden');
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

// ✅ NEU – ein einziger kompakter Embed für alle Gruppen

const fields = [];
const groups = [...new Set(monitors.map(m => m.group))].sort();

groups.forEach(group => {
  const services = monitors.filter(m => m.group === group);

  fields.push({
    name: '\u200B',
    value: `**${group.toUpperCase()}  [${services.length}]**\n${'─'.repeat(32)}`,
    inline: false
  });

  services.forEach(service => {
    fields.push(createServiceField(service));
  });
});

const nowDate = new Date();                                    // ← geändert
const dateStr = nowDate.toLocaleDateString('de-DE');           // ← geändert
const timeStr = nowDate.toLocaleTimeString('de-DE', {          // ← geändert
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});

const embeds = [{
  color: 0x2F3136,
  fields: fields.slice(0, 25),
  footer: { text: 'Uptime Kuma Status · Automatisch generiert' },
  timestamp: new Date().toISOString()
}];

const statusContent = `**🌐 LIVE SERVICE STATUS** | Stand: ${dateStr}, ${timeStr}`;

  try {
    if (statusMessageId) {
      try {
        const existingMessage = await channel.messages.fetch(statusMessageId);
        await existingMessage.edit({ content: statusContent, embeds: embeds.slice(0, 10) });
      } catch {
        const newMessage = await channel.send({ content: statusContent, embeds: embeds.slice(0, 10) });
        statusMessageId = newMessage.id;
        saveState({ statusMessageId, lastChannelStatus, lastChannelNameMs });
      }
    } else {
      const newMessage = await channel.send({ content: statusContent, embeds: embeds.slice(0, 10) });
      statusMessageId = newMessage.id;
      saveState({ statusMessageId, lastChannelStatus, lastChannelNameMs });
    }
    lastEditTimestamp = Date.now();
    logger.info(`Status aktualisiert: ${operationalCount}/${monitors.length} Dienste online`);

    // Channel-Name + Topic bei Statuswechsel aktualisieren
    await updateChannelIndicator(channel, monitors);
  } catch (error) {
    logger.error(`Discord-Nachrichtenfehler: ${error.message}`);
    statusMessageId = null;
  }
}

// ── 18. DB-CLEANUP ────────────────────────────────────────────────────────────
async function cleanupOldEntries() {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const deleted = await MonitorStatus.destroy({ where: { createdAt: { [Op.lt]: cutoff } } });
    if (deleted > 0) logger.info(`DB-Cleanup: ${deleted} alte Eintr\u00e4ge gel\u00f6scht (older than 30 days)`);
  } catch (err) {
    logger.error(`DB-Cleanup fehlgeschlagen: ${err.message}`);
  }
}

// ── 19. UPTIME-BERECHNUNG ─────────────────────────────────────────────────────
async function calculateUptimeMetrics() {
  const total = await MonitorStatus.count();
  if (total === 0) return '0.00';
  const up = await MonitorStatus.count({ where: { status: 'up' } });
  return ((up / total) * 100).toFixed(2);
}

// ── 20. SLASH-COMMANDS REGISTRIEREN ──────────────────────────────────────────
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

// ── 21. SLASH-COMMAND HANDLER ─────────────────────────────────────────────────
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

// ── 22. WEB ENDPOINTS ─────────────────────────────────────────────────────────
app.get('/health', localOnly, async (req, res) => {
  let dbStatus = 'OK';
  try {
    await sequelize.authenticate();
  } catch {
    dbStatus = 'ERROR';
  }
  res.json({
    status: 'OK',
    uptime: process.uptime(),
    checks: {
      database: dbStatus,
      discord: client.isReady() ? 'OK' : 'OFFLINE'
    }
  });
});

app.get('/dashboard', dashboardAuth, (req, res) => {
  res.render('dashboard');
});

app.get('/metrics', localOnly, async (req, res) => {
  try {
    const metrics = await prom.register.metrics();
    res.set('Content-Type', prom.register.contentType);
    res.end(metrics);
  } catch (error) {
    res.status(500).end();
  }
});

// ── 22b. DASHBOARD API ────────────────────────────────────────────────────────

app.get('/api/status', dashboardAuth, async (req, res) => {
  try {
    const monitors = await getMonitorData();
    res.json({ ok: true, monitors: monitors ?? [] });
  } catch (err) {
    logger.error(`/api/status Fehler: ${err.message}`);
    res.json({ ok: false, error: err.message, monitors: [] });
  }
});

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

app.get('/api/logs', dashboardAuth, (req, res) => {
  try {
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) return res.json({ ok: true, lines: [], file: null });
    const files = fs.readdirSync(logDir)
      .filter(f => f.endsWith('.log'))
      .sort()
      .reverse();
    if (!files.length) return res.json({ ok: true, lines: [], file: null });
    const latest  = path.join(logDir, files[0]);
    const content  = fs.readFileSync(latest, 'utf8');
    const lines    = content.split('\n').filter(Boolean).slice(-100).reverse();
    res.json({ ok: true, lines, file: files[0] });
  } catch (err) {
    logger.error(`/api/logs Fehler: ${err.message}`);
    res.json({ ok: false, error: err.message, lines: [], file: null });
  }
});

app.post('/api/refresh', dashboardAuth, async (req, res) => {
  try {
    await updateStatusMessage();
    res.json({ ok: true, message: 'Status-Nachricht aktualisiert' });
  } catch (err) {
    logger.error(`/api/refresh Fehler: ${err.message}`);
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/update-check', dashboardAuth, (req, res) => {
  const { execSync } = require('child_process');
  try {
    const botDir = __dirname;
    // Prüfen ob git-Repo
    try { execSync('git rev-parse --is-inside-work-tree', { cwd: botDir, stdio: 'ignore' }); }
    catch { return res.json({ ok: true, hasGit: false, updateAvailable: false }); }

    // fetch mit 8s Timeout
    try { execSync('git fetch origin main --quiet', { cwd: botDir, timeout: 8000, stdio: 'ignore' }); }
    catch { return res.json({ ok: true, hasGit: true, fetchFailed: true, updateAvailable: false }); }

    const behind  = parseInt(execSync('git rev-list HEAD..origin/main --count', { cwd: botDir }).toString().trim(), 10) || 0;
    const ahead   = parseInt(execSync('git rev-list origin/main..HEAD --count', { cwd: botDir }).toString().trim(), 10) || 0;
    const local   = execSync('git rev-parse --short HEAD',         { cwd: botDir }).toString().trim();
    const remote  = execSync('git rev-parse --short origin/main',  { cwd: botDir }).toString().trim();

    let commits = [];
    if (behind > 0) {
      commits = execSync(
        'git log HEAD..origin/main --oneline --format=%h|||%s|||%cr',
        { cwd: botDir }
      ).toString().trim().split('\n').filter(Boolean).slice(0, 10).map(l => {
        const [hash, subject, when] = l.split('|||');
        return { hash, subject, when };
      });
    }

    res.json({ ok: true, hasGit: true, fetchFailed: false, updateAvailable: behind > 0,
               behind, ahead, local, remote, commits });
  } catch (err) {
    logger.error(`/api/update-check Fehler: ${err.message}`);
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/update-run', dashboardAuth, (req, res) => {
  // Sicherheit: nur zulässige Modi
  const ALLOWED_MODES = ['auto', 'native', 'docker'];
  const mode = ALLOWED_MODES.includes(req.body?.mode) ? req.body.mode : 'auto';
  const { spawn }  = require('child_process');
  const scriptPath = path.join(__dirname, 'update.sh');

  if (!fs.existsSync(scriptPath)) {
    return res.json({ ok: false, error: 'update.sh nicht gefunden' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const proc = spawn('bash', [scriptPath, '--bot-dir', __dirname, '--mode', mode, '--yes'],
    { cwd: __dirname });

  const send = (line) => res.write(`data: ${line.replace(/\n/g, ' ')}\n\n`);

  proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(send));
  proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(send));
  proc.on('close', code => {
    res.write(`data: __EXIT__:${code}\n\n`);
    res.end();
  });
});

// ── Cloudflare Tunnel Status ──────────────────────────────────────────────────
// ── GET /api/config — Konfigurationswerte lesen (Token maskiert) ──────────────
app.get('/api/config', dashboardAuth, (req, res) => {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return res.json({ ok: false, error: '.env nicht gefunden' });
  }
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const get = (key) => {
      const m = raw.match(new RegExp(`^${key}=(.*)$`, 'm'));
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    };
    const token = get('DISCORD_TOKEN');
    const masked = token.length > 12
      ? `${token.slice(0, 6)}${'*'.repeat(token.length - 12)}${token.slice(-6)}`
      : token ? '***' : '';
    res.json({
      ok: true,
      DISCORD_TOKEN:                masked,
      STATUS_CHANNEL_ID:            get('STATUS_CHANNEL_ID'),
      DISCORD_NOTIFICATION_CHANNEL: get('DISCORD_NOTIFICATION_CHANNEL'),
      UPTIME_KUMA_URL:              get('UPTIME_KUMA_URL'),
      CHANNEL_STATUS_INDICATOR:     get('CHANNEL_STATUS_INDICATOR') || 'true',
    });
  } catch (err) {
    logger.error(`/api/config GET Fehler: ${err.message}`);
    res.json({ ok: false, error: err.message });
  }
});

// ── POST /api/config — Konfigurationswerte schreiben + Bot neu starten ────────
app.post('/api/config', dashboardAuth, (req, res) => {
  const ALLOWED = ['DISCORD_TOKEN', 'STATUS_CHANNEL_ID', 'DISCORD_NOTIFICATION_CHANNEL', 'UPTIME_KUMA_URL', 'CHANNEL_STATUS_INDICATOR'];
  const envPath = path.join(__dirname, '.env');

  if (!fs.existsSync(envPath)) {
    return res.json({ ok: false, error: '.env nicht gefunden' });
  }

  const updates = {};
  for (const key of ALLOWED) {
    const raw = req.body?.[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const val = String(raw).trim();

    // Token: überspringen wenn noch maskiert (enthält ***)
    if (key === 'DISCORD_TOKEN') {
      if (val.includes('*')) continue;
      if (/[\n\r]/.test(val)) return res.json({ ok: false, error: 'Ungültiger Token (enthält Zeilenumbruch)' });
    }
    // Channel-IDs: nur Ziffern
    if ((key === 'STATUS_CHANNEL_ID' || key === 'DISCORD_NOTIFICATION_CHANNEL') && !/^\d+$/.test(val)) {
      return res.json({ ok: false, error: `${key}: Nur Zahlen erlaubt (Discord ID)` });
    }
    // URL-Format
    if (key === 'UPTIME_KUMA_URL' && !/^https?:\/\/.+/.test(val)) {
      return res.json({ ok: false, error: 'UPTIME_KUMA_URL muss mit http:// oder https:// beginnen' });
    }
    // Boolean
    if (key === 'CHANNEL_STATUS_INDICATOR' && !['true', 'false'].includes(val)) {
      return res.json({ ok: false, error: 'CHANNEL_STATUS_INDICATOR muss true oder false sein' });
    }

    updates[key] = val;
  }

  if (Object.keys(updates).length === 0) {
    return res.json({ ok: false, error: 'Keine Änderungen übermittelt' });
  }

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

  // Bot-Service neu starten (nur auf systemd-Systemen)
  const { execFile } = require('child_process');
  execFile('systemctl', ['restart', 'bockis-bot'], { timeout: 10000 }, (e) => {
    res.json({
      ok: true,
      updated: Object.keys(updates),
      restarted: !e,
      restartNote: e ? 'Service-Neustart fehlgeschlagen (kein systemd?)' : null,
    });
  });
});

app.get('/api/tunnel-status', dashboardAuth, (req, res) => {
  const { execFile } = require('child_process');
  execFile('systemctl', ['is-active', 'cloudflared'], { timeout: 4000 }, (err, stdout) => {
    const active = (stdout || '').trim() === 'active';
    execFile('cloudflared', ['--version'], { timeout: 4000 }, (e2, ver) => {
      const installed = !e2;
      const version = installed ? (ver || '').trim().split('\n')[0] : null;
      execFile('cloudflared', ['tunnel', 'list'], { timeout: 6000 }, (e3, tunnelOut) => {
        const tunnels = [];
        if (!e3 && tunnelOut) {
          const lines = tunnelOut.trim().split('\n').slice(1);
          for (const line of lines) {
            const parts = line.trim().split(/\s{2,}/);
            if (parts.length >= 2) tunnels.push({ id: parts[0], name: parts[1] });
          }
        }
        res.json({ installed, active, version, tunnels });
      });
    });
  });
});

// ─────────────────────────────────────────────────────────
function initializeUpdateCycle() {
  const interval = config.get('checkIntervalMs');
  logger.info(`Update-Zyklus gestartet (alle ${interval / 1000}s)`);
  updateStatusMessage();
  setInterval(updateStatusMessage, interval);
  // DB-Cleanup einmal täglich ausführen
  cleanupOldEntries();
  setInterval(cleanupOldEntries, 24 * 60 * 60 * 1000);
}

// ── 24. STARTUP ───────────────────────────────────────────────────────────────

// Webserver SOFORT starten — unabhängig vom Discord-Login
// Damit ist das Dashboard auch erreichbar wenn der Token noch nicht stimmt
initializeDatabase().then(() => startWebServer()).catch(err => {
  logger.error(`DB/Webserver-Startfehler: ${err.message}`);
  startWebServer(); // Webserver trotzdem starten (ohne DB)
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
  await sequelize.sync({ alter: true });
  logger.info('Datenbank initialisiert');
}

function startWebServer() {
  const port = config.get('webPort');
  const os   = require('os');
  const ifaces = os.networkInterfaces();
  let localIp = 'localhost';
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) { localIp = iface.address; break; }
    }
    if (localIp !== 'localhost') break;
  }
  app.listen(port, '0.0.0.0', () => {
    logger.info(`Dashboard verfügbar unter http://${localIp}:${port}/dashboard`);
    logger.info(`(Auch erreichbar als http://localhost:${port}/dashboard)`);
  });
}

// ── 25. TEST-INTEGRATION ──────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'test') {
  const testSuite = {
    async initialize() {
      await sequelize.sync({ alter: true });
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

// ── 26. GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
  logger.info('Starte Shutdown...');
  await sequelize.close();
  client.destroy();
  process.exit(0);
}