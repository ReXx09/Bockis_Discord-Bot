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
    botName: {
      doc: 'Optionaler Bot-Username für Discord (leer = unverändert lassen)',
      format: String,
      default: '',
      env: 'DISCORD_BOT_NAME'
    },
    presenceText: {
      doc: 'Discord "Schaut zu" Texte, getrennt mit ; (z.B. Service Health;den Serverstatus;neue Releases)',
      format: String,
      default: 'Service Health',
      env: 'DISCORD_PRESENCE_TEXT'
    },
    presenceRotateMs: {
      doc: 'Intervall in ms fuer Rotation der "Schaut zu" Texte (min. 15000)',
      format: 'int',
      default: 90000,
      env: 'DISCORD_PRESENCE_ROTATE_MS'
    },
    enabledCommands: {
      doc: 'Aktive Slash-Commands als Komma-Liste (status,uptime,refresh,help,coinflip,dice,eightball)',
      format: String,
      default: 'status,uptime,refresh,help,coinflip,dice,eightball',
      env: 'DISCORD_ENABLED_COMMANDS'
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
      doc: 'Render-Modus für die Status-Nachricht: auto (beste Methode wählen) | direct (Link mit injiziertem OG) | graphical (Link mit Uptime-Badge-Bild) | svg_attachment (Statusgrafik als PNG-Anhang via rsvg-convert) | webhook_ascii (Webhook mit ASCII-Uptimebalken) | embed (Discord Embed) | link_preview (Legacy)',
      format: ['auto', 'direct', 'graphical', 'svg_attachment', 'webhook_ascii', 'embed', 'link_preview'],
      default: 'auto',
      env: 'DISCORD_STATUS_RENDER_MODE'
    },
    statusMessageTitle: {
      doc: 'Optionaler Titeltext oberhalb der SVG-Anhangs-Nachricht (leer = kein Text)',
      format: String,
      default: '',
      env: 'DISCORD_STATUS_MESSAGE_TITLE'
    },
    statusButtonLabel: {
      doc: 'Beschriftung des Link-Buttons unter der SVG-Grafik (leer = kein Button)',
      format: String,
      default: 'Statusseite öffnen',
      env: 'DISCORD_STATUS_BUTTON_LABEL'
    },
    statusWebUiButtonLabel: {
      doc: 'Beschriftung des Web-UI-Buttons neben dem Statusseite-Button (leer = kein Button)',
      format: String,
      default: '',
      env: 'DISCORD_WEBUI_BUTTON_LABEL'
    },
    statusWebhookUrl: {
      doc: 'Optionaler Discord Webhook für Status-Nachrichten (nur für webhook_ascii Modus)',
      format: String,
      default: '',
      env: 'DISCORD_STATUS_WEBHOOK_URL',
      sensitive: true
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
    serviceGuildId: {
      doc: 'Optionale Guild-ID nur für Dienst-Kanäle/Kategorie (leer = GUILD_ID verwenden)',
      format: String,
      default: '',
      env: 'SERVICE_GUILD_ID'
    },
    serviceCategoryName: {
      doc: 'Name der Kategorie, die für Service-Status-Kanäle erstellt wird',
      format: String,
      default: '📊 Service Status',
      env: 'SERVICE_CATEGORY_NAME'
    },
    serviceCategoryId: {
      doc: 'Optionale feste Kategorie-ID für Service-Kanäle (wenn gesetzt, hat diese Vorrang vor SERVICE_CATEGORY_NAME)',
      format: String,
      default: '',
      env: 'SERVICE_CATEGORY_ID'
    },
    serviceChannelNameMode: {
      doc: 'Namensmodus für automatisch erzeugte Service-Kanäle: strict_slug (Discord-sicher, klein) oder pretty (Groß/Klein/Emoji soweit Discord akzeptiert)',
      format: ['strict_slug', 'pretty'],
      default: 'strict_slug',
      env: 'SERVICE_CHANNEL_NAME_MODE'
    },
    serviceChannelAutoCreate: {
      doc: 'Fehlende Service-Kanäle automatisch erstellen (true) oder nur bestehende, manuell zugeordnete Kanäle verwenden (false)',
      format: Boolean,
      default: true,
      env: 'SERVICE_CHANNEL_AUTO_CREATE'
    },
    serviceChannelAutoQuiet: {
      doc: 'Service-Kanäle automatisch ruhig halten (kein Schreiben, keine Reaktionen, keine Threads für @everyone)',
      format: Boolean,
      default: true,
      env: 'SERVICE_CHANNEL_AUTO_QUIET'
    },
    serviceChannelMap: {
      doc: 'Optionale Zuordnung Monitor=ChannelID, getrennt mit ; (z.B. Next-Cloud=123;Pi-VPN=456)',
      format: String,
      default: '',
      env: 'SERVICE_CHANNEL_MAP'
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
