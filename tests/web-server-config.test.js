'use strict';

const { describeWebServerListenError, normalizeWebPort } = require('../web/server-config');
const {
  createServerProfileDefaults,
  installServerProfileConfig,
  runWithServerProfile,
  SERVER_PROFILE_ENV_PATHS,
  setServerProfileSettings,
} = require('../server-profiles');

describe('dashboard web server configuration', () => {
  test.each([
    ['3210', '3210'],
    [' 003210 ', '3210'],
    ['1', '1'],
    ['65535', '65535'],
  ])('normalizes valid port %s', (input, expected) => {
    expect(normalizeWebPort(input)).toBe(expected);
  });

  test.each(['', '0', '-1', '65536', '3210.5', '3210abc', '+3210'])('rejects invalid port %s', input => {
    expect(() => normalizeWebPort(input)).toThrow('WEB_PORT muss eine ganze Zahl zwischen 1 und 65535 sein.');
  });

  test('describes common host and port binding failures', () => {
    expect(describeWebServerListenError({ code: 'EADDRINUSE' }, '0.0.0.0', 3210))
      .toBe('Dashboard-Port 3210 auf 0.0.0.0 ist bereits belegt.');
    expect(describeWebServerListenError({ code: 'EADDRNOTAVAIL' }, '192.168.8.121', 3210))
      .toBe('Dashboard-Host 192.168.8.121 ist auf diesem Rechner nicht verfügbar.');
  });

  test('starts each new server profile with its own empty API-Football feed list', () => {
    const config = { get: path => path === 'discord.apiFootball.feeds' ? '[{"leagueId":4,"season":2028}]' : '' };

    expect(SERVER_PROFILE_ENV_PATHS.API_FOOTBALL_FEEDS).toBe('discord.apiFootball.feeds');
    expect(createServerProfileDefaults(config, 'guild-id').API_FOOTBALL_FEEDS).toBe('[]');
  });

  test('reads cleanup settings from the active server profile', async () => {
    const defaults = {
      'discord.messageCleanupEnabled': false,
      'discord.messageCleanupChannelIds': '',
      'discord.messageCleanupMaxAgeHours': 12,
    };
    const config = { get: path => defaults[path] };
    installServerProfileConfig(config);
    setServerProfileSettings('cleanup-test-guild', {
      MESSAGE_CLEANUP_ENABLED: 'true',
      MESSAGE_CLEANUP_CHANNEL_IDS: '123456789012345678',
      MESSAGE_CLEANUP_MAX_AGE_HOURS: '24',
    });

    await runWithServerProfile('cleanup-test-guild', async () => {
      expect(config.get('discord.messageCleanupEnabled')).toBe(true);
      expect(config.get('discord.messageCleanupChannelIds')).toBe('123456789012345678');
      expect(config.get('discord.messageCleanupMaxAgeHours')).toBe(24);
    });
    expect(config.get('discord.messageCleanupEnabled')).toBe(false);
  });
});