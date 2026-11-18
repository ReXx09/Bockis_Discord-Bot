const { testSuite, client } = require('../bot');
const axios = require('axios');
const fs = require('fs');
const { setServerProfileSettings } = require('../server-profiles');

describe('Status Bot', () => {
  beforeAll(async () => {
    await testSuite.initialize();
  });

  afterAll(async () => {
    await testSuite.close();
  });

  test('Database connection', async () => {
    await expect(testSuite.checkDatabase()).resolves.toBe(true);
  });

  test('Status check workflow', async () => {
    const result = await testSuite.simulateStatusCheck();
    expect(result.checksPerformed).toBeGreaterThan(0);
  });
});

describe('GitHub release banner', () => {
  test('sends repo, version and one highlight in a colored release embed', () => {
    const releaseUrl = 'https://github.com/rexx09/bockis-win_gui/releases/tag/v4.2.7';
    const payload = testSuite.buildReleaseBannerPayload({
      repository: 'rexx09/bockis-win_gui',
      tag_name: 'v4.2.7',
      name: 'Bockis System-Tool v4.2.7',
      body: '- Neue Navigation für Fenster und Vollbild.\n- Responsives Update-Layout verbessert.',
      html_url: releaseUrl,
      published_at: '2026-11-03T19:27:00Z',
    });
    const embed = payload.embeds[0].toJSON();

    expect(payload.embeds).toHaveLength(1);
    expect(payload.components).toBeUndefined();
    expect(embed.color).toBeDefined();
    expect(embed.title).toContain('rexx09/bockis-win_gui');
    expect(embed.title).toContain('v4.2.7');
    expect(embed.url).toBe(releaseUrl);
    expect(embed.description).toContain('Neue Navigation');
    expect(embed.description).not.toContain('Responsives Update');
  });

  test('sends a new release to the info and banner channels from the selected server profile', async () => {
    const guildId = '123456789012345678';
    const infoChannelId = '223456789012345678';
    const bannerChannelId = '323456789012345678';
    const repository = 'test-owner/test-repo';
    const previousGuild = client.guilds.cache.get(guildId);
    const previousInfoChannel = client.channels.cache.get(infoChannelId);
    const previousBannerChannel = client.channels.cache.get(bannerChannelId);
    const infoChannel = { isTextBased: () => true, send: jest.fn().mockResolvedValue({}) };
    const bannerChannel = { isTextBased: () => true, send: jest.fn().mockResolvedValue({}) };
    const getSpy = jest.spyOn(axios, 'get').mockResolvedValue({
      data: [{
        id: 987654321,
        tag_name: 'v1.0.0',
        name: 'Test release',
        body: '- Neues Feature zum Testen.',
        html_url: `https://github.com/${repository}/releases/tag/v1.0.0`,
        published_at: new Date().toISOString(),
        author: { login: 'test-owner' },
        prerelease: true,
        draft: false,
      }],
    });
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    client.guilds.cache.set(guildId, { id: guildId });
    client.channels.cache.set(infoChannelId, infoChannel);
    client.channels.cache.set(bannerChannelId, bannerChannel);
    setServerProfileSettings(guildId, {
      DISCORD_GITHUB_WATCH_ENABLED: true,
      DISCORD_GITHUB_CHANNEL_ID: infoChannelId,
      DISCORD_GITHUB_SECONDARY_CHANNEL_ID: bannerChannelId,
      DISCORD_GITHUB_REPOS: repository,
      DISCORD_GITHUB_MODE: 'releases',
      DISCORD_GITHUB_POST_STYLE: 'highlights',
      DISCORD_GITHUB_REPO_SETTINGS_B64: Buffer.from(JSON.stringify({
        [repository]: { mode: 'releases', postStyle: 'highlights' },
      })).toString('base64'),
    });

    try {
      await testSuite.runGitHubReleaseCheck({ notify: false, guildId });
      expect(infoChannel.send).toHaveBeenCalledTimes(1);
      expect(bannerChannel.send).toHaveBeenCalledTimes(1);
      expect(bannerChannel.send.mock.calls[0][0].embeds[0].toJSON().title).toContain(repository);
      expect(getSpy).toHaveBeenCalledWith(
        `https://api.github.com/repos/${repository}/releases?per_page=10`,
        expect.objectContaining({ timeout: 12_000 }),
      );
    } finally {
      getSpy.mockRestore();
      writeSpy.mockRestore();
      if (previousGuild) client.guilds.cache.set(guildId, previousGuild);
      else client.guilds.cache.delete(guildId);
      if (previousInfoChannel) client.channels.cache.set(infoChannelId, previousInfoChannel);
      else client.channels.cache.delete(infoChannelId);
      if (previousBannerChannel) client.channels.cache.set(bannerChannelId, previousBannerChannel);
      else client.channels.cache.delete(bannerChannelId);
    }
  });
});
