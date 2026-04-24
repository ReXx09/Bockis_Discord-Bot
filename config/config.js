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
    autoReactionEnabled: {
      doc: 'Automatische Reaktionen fuer neue Nachrichten aktivieren',
      format: Boolean,
      default: false,
      env: 'DISCORD_AUTO_REACTION_ENABLED'
    },
    autoReactionEmojis: {
      doc: 'Automatische Reaktions-Emojis, getrennt mit ; oder , (z.B. 👍;🔥;😂)',
      format: String,
      default: '👍',
      env: 'DISCORD_AUTO_REACTION_EMOJIS'
    },
    autoReactionChannelIds: {
      doc: 'Optionale Channel-IDs fuer automatische Reaktionen, getrennt mit , oder ; (leer = alle Guild-Textkanaele)',
      format: String,
      default: '',
      env: 'DISCORD_AUTO_REACTION_CHANNEL_IDS'
    },
    enabledCommands: {
      doc: 'Aktive Slash-Commands als Komma-Liste (status,uptime,refresh,help,coinflip,dice,eightball,cleanup,translate,ping,botinfo,serverstatus,ki,wetter,subscribe,remind,quote,poll,avatar,userinfo)',
      format: String,
      default: 'status,uptime,refresh,help,coinflip,dice,eightball,cleanup,translate,ping,botinfo,serverstatus,ki,wetter,subscribe,remind,quote,poll,avatar,userinfo',
      env: 'DISCORD_ENABLED_COMMANDS'
    },
    translateEnabled: {
      doc: 'Aktiviert den /translate Slash-Command',
      format: Boolean,
      default: false,
      env: 'DISCORD_TRANSLATE_ENABLED'
    },
    translateDefaultTarget: {
      doc: 'Standard-Zielsprache fuer /translate (z.B. de, en, fr)',
      format: String,
      default: 'de',
      env: 'DISCORD_TRANSLATE_DEFAULT_TARGET'
    },
    translateDefaultSource: {
      doc: 'Standard-Quellsprache fuer /translate (auto oder Sprachcode wie en)',
      format: String,
      default: 'auto',
      env: 'DISCORD_TRANSLATE_DEFAULT_SOURCE'
    },
    translateApiUrl: {
      doc: 'HTTP-Endpoint fuer Uebersetzungen (LibreTranslate kompatibel)',
      format: String,
      default: 'https://libretranslate.com/translate',
      env: 'DISCORD_TRANSLATE_API_URL'
    },
    translateApiKey: {
      doc: 'Optionaler API-Key fuer den Uebersetzungsdienst',
      format: String,
      default: '',
      env: 'DISCORD_TRANSLATE_API_KEY',
      sensitive: true
    },
    translateAllowedGuildIds: {
      doc: 'Optionale Guild-Whitelist fuer /translate (Komma/Semikolon). Leer = alle Guilds + DMs',
      format: String,
      default: '',
      env: 'DISCORD_TRANSLATE_ALLOWED_GUILD_IDS'
    },
    translateMaxTextLength: {
      doc: 'Maximale Textlaenge fuer /translate',
      format: 'int',
      default: 1800,
      env: 'DISCORD_TRANSLATE_MAX_TEXT_LENGTH'
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
      doc: 'Namensmodus für automatisch erzeugte Service-Kanäle: strict_slug (Discord-sicher, klein), pretty (lesbar + Emoji) oder mono (Monospace Look soweit Discord akzeptiert)',
      format: ['strict_slug', 'pretty', 'mono'],
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
    },
    messageCleanupEnabled: {
      doc: 'Automatische Kanal-Nachrichtenbereinigung aktivieren',
      format: Boolean,
      default: false,
      env: 'MESSAGE_CLEANUP_ENABLED'
    },
    messageCleanupChannelIds: {
      doc: 'Komma-/Semikolon-getrennte Channel-IDs fuer Cleanup (leer = DISCORD_NOTIFICATION_CHANNEL)',
      format: String,
      default: '',
      env: 'MESSAGE_CLEANUP_CHANNEL_IDS'
    },
    messageCleanupMaxMessages: {
      doc: 'Maximal erlaubte Nachrichten pro Cleanup-Kanal (0 = deaktiviert)',
      format: 'int',
      default: 4,
      env: 'MESSAGE_CLEANUP_MAX_MESSAGES'
    },
    messageCleanupMaxAgeHours: {
      doc: 'Nachrichten aelter als X Stunden loeschen (0 = deaktiviert)',
      format: 'int',
      default: 12,
      env: 'MESSAGE_CLEANUP_MAX_AGE_HOURS'
    },
    messageCleanupOnlyBotMessages: {
      doc: 'Nur Bot-Nachrichten loeschen (empfohlen)',
      format: Boolean,
      default: true,
      env: 'MESSAGE_CLEANUP_ONLY_BOT_MESSAGES'
    },
    messageCleanupIntervalMs: {
      doc: 'Intervall in ms fuer automatische Nachrichtenbereinigung (min. 60000)',
      format: 'int',
      default: 300000,
      env: 'MESSAGE_CLEANUP_INTERVAL_MS'
    },
    serviceChannelDebug: {
      doc: 'Zusatz-Debuglogs fuer Service-Kanal-Sync aktivieren',
      format: Boolean,
      default: false,
      env: 'SERVICE_CHANNEL_DEBUG'
    },
    autoReplyEnabled: {
      doc: 'Automatische Antworten auf bestimmte Nachrichten aktivieren',
      format: Boolean,
      default: false,
      env: 'DISCORD_AUTO_REPLY_ENABLED'
    },
    autoReplyMentionOnly: {
      doc: 'Auto-Reply nur bei Bot-Erwähnungen aktivieren (nicht bei allen Nachrichten)',
      format: Boolean,
      default: false,
      env: 'DISCORD_AUTO_REPLY_MENTION_ONLY'
    },
    autoReplyChannelIds: {
      doc: 'Optionale Channel-IDs für Auto-Replies, getrennt mit , oder ; (leer = alle)',
      format: String,
      default: '',
      env: 'DISCORD_AUTO_REPLY_CHANNEL_IDS'
    },
    autoReplyCooldownMs: {
      doc: 'Cooldown in ms zwischen Auto-Replies pro Nutzer (min. 1000)',
      format: 'int',
      default: 30000,
      env: 'DISCORD_AUTO_REPLY_COOLDOWN_MS'
    },
    autoReplyRulesFile: {
      doc: 'Pfad zur Auto-Reply-Regeln Datei (JSON)',
      format: String,
      default: './auto-replies.json',
      env: 'DISCORD_AUTO_REPLY_RULES_FILE'
    },
    welcomeEnabled: {
      doc: 'Willkommensnachrichten für neue Nutzer aktivieren',
      format: Boolean,
      default: false,
      env: 'DISCORD_WELCOME_ENABLED'
    },
    welcomeChannelId: {
      doc: 'Channel-ID für Willkommensnachrichten',
      format: String,
      default: '',
      env: 'DISCORD_WELCOME_CHANNEL_ID'
    },
    welcomeMessageTemplate: {
      doc: 'Template für Willkommensnachrichten ({{user}} wird durch Nutzer ersetzt)',
      format: String,
      default: 'Willkommen {{user}}! Schön, dass du hier bist.',
      env: 'DISCORD_WELCOME_MESSAGE_TEMPLATE'
    },
    githubWatchEnabled: {
      doc: 'GitHub Repository Watcher aktivieren',
      format: Boolean,
      default: false,
      env: 'DISCORD_GITHUB_WATCH_ENABLED'
    },
    githubChannelId: {
      doc: 'Channel-ID für GitHub-Benachrichtigungen',
      format: String,
      default: '',
      env: 'DISCORD_GITHUB_CHANNEL_ID'
    },
    githubRepos: {
      doc: 'GitHub Repositories zum Beobachten, Format: owner/repo, getrennt mit , oder ; (z.B. torvalds/linux,nodejs/node)',
      format: String,
      default: '',
      env: 'DISCORD_GITHUB_REPOS'
    },
    githubMode: {
      doc: 'GitHub Watcher Modus: releases (nur Releases), commits (nur Commits) oder both (beides)',
      format: ['releases', 'commits', 'both'],
      default: 'releases',
      env: 'DISCORD_GITHUB_MODE'
    },
    githubPollIntervalMs: {
      doc: 'Intervall in ms für GitHub Poll (min. 60000 = 1 Minute)',
      format: 'int',
      default: 300000,
      env: 'DISCORD_GITHUB_POLL_INTERVAL_MS'
    },
    githubToken: {
      doc: 'Optionaler GitHub Token für höhere Rate-Limits (ghp_... oder github_pat_...)',
      format: String,
      default: '',
      env: 'GITHUB_TOKEN',
      sensitive: true
    }
  },
  cloudflare: {
    publicUrl: {
      doc: 'Öffentliche Cloudflare Tunnel URL (z.B. https://status.example.com). Wird als Status-Seiten-Link in Discord gepostet – muss öffentlich erreichbar sein damit Discord die Seite einbetten kann.',
      format: String,
      default: '',
      env: 'CLOUDFLARE_PUBLIC_URL'
    }
  },
  openai: {
    enabled: {
      doc: 'KI-Chat via OpenAI aktivieren (Bot antwortet auf Mentions & DMs)',
      format: Boolean,
      default: false,
      env: 'OPENAI_ENABLED'
    },
    baseUrl: {
      doc: 'OpenAI-kompatible API Base URL (z.B. https://api.openai.com/v1 oder https://api.groq.com/openai/v1)',
      format: String,
      default: 'https://api.openai.com/v1',
      env: 'OPENAI_BASE_URL'
    },
    apiKey: {
      doc: 'OpenAI API-Key (sk-...)',
      format: String,
      default: '',
      env: 'OPENAI_API_KEY',
      sensitive: true
    },
    model: {
      doc: 'OpenAI Modell (z.B. gpt-4o-mini, gpt-4o, gpt-3.5-turbo)',
      format: String,
      default: 'gpt-4o-mini',
      env: 'OPENAI_MODEL'
    },
    personaName: {
      doc: 'Name der Bot-Persönlichkeit im Chat (z.B. Bockis)',
      format: String,
      default: 'Bockis',
      env: 'OPENAI_PERSONA_NAME'
    },
    systemPrompt: {
      doc: 'System-Prompt für die Bot-Persönlichkeit (leer = Standard)',
      format: String,
      default: '',
      env: 'OPENAI_SYSTEM_PROMPT'
    },
    channelIds: {
      doc: 'Optionale Kanal-IDs in denen der KI-Chat aktiv ist, getrennt mit , oder ; (leer = überall)',
      format: String,
      default: '',
      env: 'OPENAI_CHANNEL_IDS'
    },
    maxTokens: {
      doc: 'Maximale Antwort-Tokens pro Anfrage (50–2000)',
      format: 'int',
      default: 600,
      env: 'OPENAI_MAX_TOKENS'
    },
    allowDMs: {
      doc: 'Bot antwortet auch auf Direktnachrichten (DMs)',
      format: Boolean,
      default: true,
      env: 'OPENAI_ALLOW_DMS'
    },
    rateLimitPerMinute: {
      doc: 'Maximale Anfragen pro Nutzer pro Minute (Schutz vor Missbrauch)',
      format: 'int',
      default: 5,
      env: 'OPENAI_RATE_LIMIT_PER_MINUTE'
    }
  }
});

config.validate({ allowed: 'strict' });

module.exports = config;
