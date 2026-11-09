'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const serverProfileContext = new AsyncLocalStorage();
const profileSettingsByGuild = new Map();

const SERVER_PROFILE_ENV_PATHS = Object.freeze({
  DISCORD_AUTO_REACTION_ENABLED: 'discord.autoReactionEnabled',
  DISCORD_AUTO_REACTION_EMOJIS: 'discord.autoReactionEmojis',
  DISCORD_AUTO_REACTION_CHANNEL_IDS: 'discord.autoReactionChannelIds',
  DISCORD_ENABLED_COMMANDS: 'discord.enabledCommands',
  DISCORD_COMMANDS_CHANNEL_ID: 'discord.commandsChannelId',
  DISCORD_COMMAND_TILE_TEMPLATE_B64: 'discord.commandTileTemplateB64',
  DISCORD_COMMAND_TILE_MODE: 'discord.commandTileMode',
  STATUS_CHANNEL_ID: 'discord.statusChannelId',
  DISCORD_NOTIFICATION_CHANNEL: 'discord.notificationChannel',
  DISCORD_STATUS_RENDER_MODE: 'discord.statusRenderMode',
  DISCORD_STATUS_MESSAGE_TITLE: 'discord.statusMessageTitle',
  DISCORD_STATUS_BUTTON_LABEL: 'discord.statusButtonLabel',
  DISCORD_WEBUI_BUTTON_LABEL: 'discord.statusWebUiButtonLabel',
  CHANNEL_STATUS_INDICATOR: 'discord.channelStatusIndicator',
  GUILD_ID: 'discord.guildId',
  SERVICE_GUILD_ID: 'discord.serviceGuildId',
  SERVICE_CATEGORY_NAME: 'discord.serviceCategoryName',
  SERVICE_CATEGORY_ID: 'discord.serviceCategoryId',
  SERVICE_CHANNEL_NAME_MODE: 'discord.serviceChannelNameMode',
  SERVICE_CHANNEL_AUTO_CREATE: 'discord.serviceChannelAutoCreate',
  SERVICE_CHANNEL_AUTO_QUIET: 'discord.serviceChannelAutoQuiet',
  SERVICE_CHANNEL_MAP: 'discord.serviceChannelMap',
  MONITORED_SERVICES: 'discord.monitoredServices',
  MESSAGE_CLEANUP_ENABLED: 'discord.messageCleanupEnabled',
  MESSAGE_CLEANUP_INFO_ENABLED: 'discord.messageCleanupInfoEnabled',
  MESSAGE_CLEANUP_ONLY_BOT_MESSAGES: 'discord.messageCleanupOnlyBotMessages',
  MESSAGE_CLEANUP_CHANNEL_IDS: 'discord.messageCleanupChannelIds',
  MESSAGE_CLEANUP_MAX_MESSAGES: 'discord.messageCleanupMaxMessages',
  MESSAGE_CLEANUP_MAX_AGE_HOURS: 'discord.messageCleanupMaxAgeHours',
  MESSAGE_CLEANUP_INTERVAL_MS: 'discord.messageCleanupIntervalMs',
  DISCORD_AUTO_REPLY_ENABLED: 'discord.autoReplyEnabled',
  DISCORD_AUTO_REPLY_MENTION_ONLY: 'discord.autoReplyMentionOnly',
  DISCORD_AUTO_REPLY_CHANNEL_IDS: 'discord.autoReplyChannelIds',
  DISCORD_AUTO_REPLY_COOLDOWN_MS: 'discord.autoReplyCooldownMs',
  DISCORD_AUTO_REPLY_RULES_FILE: 'discord.autoReplyRulesFile',
  DISCORD_AUTO_REPLY_RESPONSE_MODE: 'discord.autoReplyResponseMode',
  DISCORD_AUTO_REPLY_CONNECTOR: 'discord.autoReplyConnector',
  DISCORD_WELCOME_ENABLED: 'discord.welcomeEnabled',
  DISCORD_WELCOME_CHANNEL_ID: 'discord.welcomeChannelId',
  DISCORD_WELCOME_MESSAGE_TEMPLATE: 'discord.welcomeMessageTemplate',
  DISCORD_GITHUB_WATCH_ENABLED: 'discord.githubWatchEnabled',
  DISCORD_GITHUB_CHANNEL_ID: 'discord.githubChannelId',
  DISCORD_GITHUB_SECONDARY_CHANNEL_ID: 'discord.githubSecondaryChannelId',
  DISCORD_GITHUB_REPOS: 'discord.githubRepos',
  DISCORD_GITHUB_MODE: 'discord.githubMode',
  DISCORD_GITHUB_POLL_INTERVAL_MS: 'discord.githubPollIntervalMs',
  DISCORD_GITHUB_HIGHLIGHTS_MAX: 'discord.githubHighlightsMax',
  DISCORD_GITHUB_HIGHLIGHTS_AI: 'discord.githubHighlightsAi',
  DISCORD_GITHUB_RELEASE_TEMPLATE: 'discord.githubReleaseTemplate',
  OPENAI_ENABLED: 'openai.enabled',
  OPENAI_CHANNEL_IDS: 'openai.channelIds',
  OPENAI_ALLOW_DMS: 'openai.allowDMs',
  OPENAI_NAME_TRIGGER_ENABLED: 'openai.nameTriggerEnabled',
  OPENAI_RATE_LIMIT_PER_MINUTE: 'openai.rateLimitPerMinute',
  OPENAI_PERSONA_NAME: 'openai.personaName',
  OPENAI_SYSTEM_PROMPT: 'openai.systemPrompt',
  DISCORD_TRANSLATE_ENABLED: 'discord.translateEnabled',
  DISCORD_TRANSLATE_DEFAULT_TARGET: 'discord.translateDefaultTarget',
  DISCORD_TRANSLATE_DEFAULT_SOURCE: 'discord.translateDefaultSource',
  DISCORD_TRANSLATE_PROVIDER: 'discord.translateProvider',
  DISCORD_TRANSLATE_API_URL: 'discord.translateApiUrl',
  DISCORD_TRANSLATE_ALLOWED_GUILD_IDS: 'discord.translateAllowedGuildIds',
  DISCORD_TRANSLATE_MAX_TEXT_LENGTH: 'discord.translateMaxTextLength',
});

function parseProfileValue(value, defaultValue) {
  if (typeof defaultValue === 'boolean') return value === true || String(value).toLowerCase() === 'true';
  if (typeof defaultValue === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  }
  return value == null ? defaultValue : String(value);
}

function setServerProfileSettings(guildId, settings) {
  if (!guildId) return;
  profileSettingsByGuild.set(String(guildId), { ...(settings || {}) });
}

function getServerProfileSettings(guildId) {
  return profileSettingsByGuild.get(String(guildId || '')) || null;
}

function createServerProfileDefaults(config, guildId) {
  const settings = Object.fromEntries(
    Object.entries(SERVER_PROFILE_ENV_PATHS).map(([envKey, path]) => [envKey, config.get(path)])
  );
  for (const key of Object.keys(settings)) {
    if (/_CHANNEL_ID$|_CHANNEL_IDS$|_GUILD_ID$|_CATEGORY_ID$/.test(key)
      || key === 'SERVICE_CHANNEL_MAP' || key === 'MONITORED_SERVICES') {
      settings[key] = '';
    }
    if (/_ENABLED$/.test(key)) settings[key] = false;
  }
  settings.DISCORD_ENABLED_COMMANDS = '';
  settings.GUILD_ID = String(guildId);
  settings.SERVICE_GUILD_ID = String(guildId);
  settings.DISCORD_AUTO_REPLY_RULES_FILE = `./data/auto-replies-${guildId}.json`;
  return settings;
}

function getCurrentServerProfileId() {
  return serverProfileContext.getStore() || null;
}

function withServerProfile(handler) {
  return (...args) => {
    const source = args[0];
    const guildId = source?.guildId || source?.guild?.id || source?.member?.guild?.id || null;
    return serverProfileContext.run(guildId ? String(guildId) : null, () => handler(...args));
  };
}

function runWithServerProfile(guildId, callback) {
  return serverProfileContext.run(guildId ? String(guildId) : null, callback);
}

function installServerProfileConfig(config) {
  const originalGet = config.get.bind(config);
  const envByPath = new Map(Object.entries(SERVER_PROFILE_ENV_PATHS).map(([env, path]) => [path, env]));
  config.get = (path) => {
    const guildId = getCurrentServerProfileId();
    const envKey = envByPath.get(path);
    const settings = guildId && envKey ? getServerProfileSettings(guildId) : null;
    if (settings && Object.prototype.hasOwnProperty.call(settings, envKey)) {
      return parseProfileValue(settings[envKey], originalGet(path));
    }
    return originalGet(path);
  };
}

module.exports = {
  SERVER_PROFILE_ENV_PATHS,
  createServerProfileDefaults,
  getServerProfileSettings,
  installServerProfileConfig,
  runWithServerProfile,
  setServerProfileSettings,
  withServerProfile,
};