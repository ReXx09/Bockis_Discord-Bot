const convict = require('convict');

const config = convict({
  environment: {
    doc: 'Application environment',
    format: ['production', 'development', 'test'],
    default: 'development',
    env: 'NODE_ENV'
  },
  webPort: {
    doc: 'Webserver port',
    format: 'port',
    default: 3000,
    env: 'WEB_PORT'
  },
  checkIntervalMs: {
    doc: 'Intervall in ms zwischen Status-Updates',
    format: 'int',
    default: 300000,
    env: 'UPDATE_INTERVAL'
  },
  database: {
    dialect: {
      doc: 'Datenbank-Dialekt (sqlite, postgres, ...)',
      format: String,
      default: 'sqlite',
      env: 'DB_DIALECT'
    },
    storage: {
      doc: 'Pfad zur SQLite-Datei',
      format: String,
      default: './data/status.db',
      env: 'DB_STORAGE'
    }
  },
  uptimeKuma: {
    url: {
      doc: 'Basis-URL der Uptime Kuma Instanz (z.B. http://uptime.example.com)',
      format: String,
      default: '',
      env: 'UPTIME_KUMA_URL'
    },
    apiKey: {
      doc: 'Optionaler Uptime Kuma API Key',
      format: String,
      default: '',
      env: 'UPTIME_KUMA_API_KEY',
      sensitive: true
    },
    statusPageSlug: {
      doc: 'Slug der Uptime Kuma Status-Page (z.B. dienste)',
      format: String,
      default: 'dienste',
      env: 'STATUS_PAGE_SLUG'
    }
  },
  discord: {
    token: {
      doc: 'Discord Bot Token',
      format: String,
      default: '',
      env: 'DISCORD_TOKEN',
      sensitive: true
    },
    statusChannelId: {
      doc: 'Channel-ID für die gepinnte Status-Nachricht',
      format: String,
      default: '',
      env: 'STATUS_CHANNEL_ID'
    },
    notificationChannel: {
      doc: 'Channel-ID für Statusänderungs-Benachrichtigungen',
      format: String,
      default: '',
      env: 'DISCORD_NOTIFICATION_CHANNEL'
    }
  }
});

config.validate({ allowed: 'strict' });

module.exports = config;
