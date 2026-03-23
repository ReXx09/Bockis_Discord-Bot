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
app.use(express.static('public'));

// ── 7. MIDDLEWARE ─────────────────────────────────────────────────────────────
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

let statusMessageId = loadState().statusMessageId ?? null;

// ── 12. RATE-LIMIT SCHUTZ ─────────────────────────────────────────────────────
let lastEditTimestamp = 0;
const MIN_EDIT_INTERVAL_MS = 5_000;

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
  const barLength = Math.floor(monitor.uptime / 10);

  return {
    name: `${theme.icon} ${monitor.name}`,
    value: [
      `**${theme.title}**`,
      `*${theme.description}*`,
      `\`${theme.bar.slice(0, barLength).padEnd(10, '\u25B1')}\``,
      `\uD83D\uDCCA **Uptime:** ${monitor.uptime}%`,
      `\u23F1 **Last Check:** <t:${Math.floor(new Date(monitor.time).getTime() / 1000)}:R>`,
      monitor.ping ? `\uD83D\uDCF6 **Latency:** ${monitor.ping}ms` : ''
    ].join('\n'),
    inline: true
  };
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

  const embeds = [];
  const groups = [...new Set(monitors.map(m => m.group))].sort();

  groups.forEach(group => {
    const services = monitors.filter(m => m.group === group);
    const fields = [];

    fields.push({
      name: `\uD83D\uDCC1  ${group.toUpperCase()}  [${services.length}]`,
      value: '\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC\u25AC',
      inline: false
    });

    services.forEach((service, index) => {
      fields.push(createServiceField(service));
      if ((index + 1) % 3 === 0) fields.push({ name: '\u200B', value: '\u200B', inline: false });
    });

    fields.push({ name: '\u200B', value: '\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554\u2554', inline: false });

    embeds.push({
      color: 0x2F3136,
      title: '\uD83D\uDDA5\uFE0F\u3000SERVICE\u3000MONITOR',
      description: [
        '```ansi',
        '\u001b[34m\u250F\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2513',
        '\u001b[34m\u2503\u3000\u3000\u3000\u3000\u3000\u3000\u001b[37m\uD835\uDE02\uD835\uDE08\uD835\uDE02\uD835\uDE03\uD835\uDD74\uD835\uDD74 \uD835\uDE02\uD835\uDE03\uD835\uDD70\uD835\uDE03\uD835\uDE04\uD835\uDE02\u001b[34m\u3000\u3000\u3000\u3000\u3000\u3000\u2503',
        '\u001b[34m\u2517\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u251B```'
      ].join('\n'),
      fields: fields.slice(0, 25),
      footer: { text: 'Last refresh' },
      timestamp: new Date().toISOString()
    });
  });

  try {
    const uptimeKumaUrl = config.get('uptimeKuma.url');
    const slug = config.get('uptimeKuma.statusPageSlug');
    const statusContent = `**\uD83C\uDF10 LIVE SERVICE STATUS**\n\uD83D\uDD17 [---------->>>>>  Full Status Page  <<<<<----------](${uptimeKumaUrl}/status/${slug})`;
    if (statusMessageId) {
      try {
        const existingMessage = await channel.messages.fetch(statusMessageId);
        await existingMessage.edit({ content: statusContent, embeds: embeds.slice(0, 10) });
      } catch {
        const newMessage = await channel.send({ content: statusContent, embeds: embeds.slice(0, 10) });
        statusMessageId = newMessage.id;
        saveState({ statusMessageId });
      }
    } else {
      const newMessage = await channel.send({ content: statusContent, embeds: embeds.slice(0, 10) });
      statusMessageId = newMessage.id;
      saveState({ statusMessageId });
    }
    lastEditTimestamp = Date.now();
    logger.info(`Status aktualisiert: ${operationalCount}/${monitors.length} Dienste online`);
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

app.get('/dashboard', dashboardAuth, async (req, res) => {
  try {
    const statusData = await MonitorStatus.findAll({
      order: [['createdAt', 'DESC']],
      limit: 50
    });
    res.render('dashboard', {
      statuses: statusData,
      uptime: await calculateUptimeMetrics()
    });
  } catch (error) {
    logger.error(`Dashboard-Fehler: ${error.message}`);
    res.status(500).send('Dashboard error');
  }
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

// ── 23. UPDATE-ZYKLUS ─────────────────────────────────────────────────────────
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
client.once('ready', async () => {
  logger.info(`Bot eingeloggt als ${client.user.tag}`);
  client.user.setActivity('Service Health', { type: ActivityType.Watching });
  await initializeDatabase();
  await registerSlashCommands();
  startWebServer();
  initializeUpdateCycle();
});

async function initializeDatabase() {
  await sequelize.sync({ alter: true });
  logger.info('Datenbank initialisiert');
}

function startWebServer() {
  const port = config.get('webPort');
  app.listen(port, () => {
    logger.info(`Dashboard verf\u00fcgbar unter http://localhost:${port}`);
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

client.login(config.get('discord.token'));