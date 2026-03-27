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
    },
    statusRenderMode: {
      doc: 'Render-Modus für die Status-Nachricht: auto (beste Methode wählen) | direct (Link mit injiziertem OG) | graphical (Link mit Uptime-Badge-Bild) | embed (Discord Embed)',
      format: ['auto', 'direct', 'graphical', 'embed'],
      default: 'auto',
      env: 'DISCORD_STATUS_RENDER_MODE'
    },
    channelStatusIndicator: {
      doc: 'Channel-Name und Topic automatisch mit Statusfarbe aktualisieren (🟢/🟡/🔴)',
      format: Boolean,
      default: true,
      env: 'CHANNEL_STATUS_INDICATOR'
    },
    guildId: {
      doc: 'Guild-ID des Discord-Servers (erforderlich für den Service-Kanal-Manager)',
      format: String,
      default: '',
      env: 'GUILD_ID'
    },
    serviceCategoryName: {
      doc: 'Name der Kategorie, die für Service-Status-Kanäle erstellt wird',
      format: String,
      default: '📊 Service Status',
      env: 'SERVICE_CATEGORY_NAME'
    },
    monitoredServices: {
      doc: 'Kommagetrennte Liste der Dienste, die als eigene Kanäle angezeigt werden (leer = alle aktiven)',
      format: String,
      default: '',
      env: 'MONITORED_SERVICES'
    }
  },
  cloudflare: {
    publicUrl: {
      doc: 'Öffentliche Cloudflare Tunnel URL (z.B. https://status.example.com). Wird als Status-Seiten-Link in Discord gepostet – muss öffentlich erreichbar sein damit Discord die Seite einbetten kann.',
      format: String,
      default: '',
      env: 'CLOUDFLARE_PUBLIC_URL'
    }
  }
});

config.validate({ allowed: 'strict' });

module.exports = config;
