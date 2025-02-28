require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');
const { JSDOM } = require('jsdom');
const winston = require('winston');
const { retry } = require('async');
const express = require('express');
const prom = require('prom-client');
const { Sequelize, DataTypes } = require('sequelize');

// 1. Erweiterte Konfiguration
const config = require('./config/config').getConfig();

// 2. Datenbank-Initialisierung
const sequelize = new Sequelize(config.database);
const MonitorStatus = require('./models/MonitorStatus')(sequelize, DataTypes);

// 3. Metrik-Sammlung
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

// 4. Express Dashboard
const app = express();
app.set('view engine', 'ejs');
app.use(express.static('public'));

// 5. Notification Manager
class NotificationManager {
  constructor() {
    this.lastStatus = new Map();
  }

  async checkForNotifications(monitor, status) {
    if (this.lastStatus.has(monitor.id) && this.lastStatus.get(monitor.id) !== status) {
      await this.sendNotification(monitor, status);
    }
    this.lastStatus.set(monitor.id, status);
  }

  async sendNotification(monitor, status) {
    const channel = await client.channels.fetch(config.notificationChannel);
    const message = `🚨 Statusänderung bei ${monitor.name}: ${status.toUpperCase()}`;
    await channel.send(message);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const notificationManager = new NotificationManager();

// 6. Health Check Endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    uptime: process.uptime(),
    checks: {
      database: sequelize.authenticate ? 'OK' : 'ERROR',
      discord: client.isReady() ? 'OK' : 'OFFLINE'
    }
  });
});

// 7. Status Dashboard
app.get('/dashboard', async (req, res) => {
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
    res.status(500).send('Dashboard error');
  }
});

// 8. Metrik-Endpoint
app.get('/metrics', async (req, res) => {
  try {
    const metrics = await prom.register.metrics();
    res.set('Content-Type', prom.register.contentType);
    res.end(metrics);
  } catch (error) {
    res.status(500).end();
  }
});

// 9. Erweiterte Hauptlogik
client.once('ready', async () => {
  await initializeDatabase();
  startWebServer();
  initializeUpdateCycle();
});

async function initializeDatabase() {
  await sequelize.sync({ alter: true });
  logger.info('Datenbank initialisiert');
}

function startWebServer() {
  app.listen(config.webPort, () => {
    logger.info(`Dashboard verfügbar unter http://localhost:${config.webPort}`);
  });
}

async function performUpdate() {
  const startTime = Date.now();
  try {
    const monitors = await getMonitorsWithCache();
    let operationalServices = 0;

    for (const monitor of monitors) {
      const status = await getMonitorStatus(monitor.id);
      await MonitorStatus.create({
        monitorId: monitor.id,
        status,
        responseTime: Date.now() - startTime
      });
      
      await notificationManager.checkForNotifications(monitor, status);
      if (status === 'up') operationalServices++;
    }

    const uptime = (operationalServices / monitors.length) * 100;
    uptimeGauge.set(uptime);
    statusCheckCounter.inc();

    await updateDiscordChannel(operationalServices, monitors.length);
  } catch (error) {
    logger.error(`Update fehlgeschlagen: ${error.message}`);
  }
}

// 10. Test-Integration
if (process.env.NODE_ENV === 'test') {
  const testSuite = require('./tests/integration');
  module.exports = { client, sequelize, testSuite };
}

// Graceful Shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
  logger.info('Starte Shutdown...');
  await sequelize.close();
  client.destroy();
  process.exit(0);
}

client.login(config.discord.token);
