const { testSuite } = require('../bot');

describe('Status Bot', () => {
  beforeAll(async () => {
    await testSuite.initialize();
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
});
