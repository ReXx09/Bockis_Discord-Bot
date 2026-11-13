const {
  buildScoreboardPayload,
  buildFinishedMatchPng,
  buildGoalEventPng,
  buildNextMatchCountdownMessage,
  buildNextMatchCountdownPng,
  buildNextMatchCountdownPayload,
  buildLiveTablePayload,
  createOpenLigaDbWatcher,
  fetchLatestLeagueTeams,
  getAvailableFootballLeagues,
  getFavoriteTeamIds,
  getDefaultCountdownColor,
  getOpenLigaDbUpdateIntervalMs,
  getMatchScore,
  getMatchStatus,
  getSeasonForLeague,
  OPENLIGADB_COUNTDOWN_STYLES,
} = require('../services/openligadb');
const { createApiUsageTracker } = require('../services/api-usage');
const {
  API_FOOTBALL_COMPETITIONS,
  buildApiFootballFavoriteMatchPayload,
  buildApiFootballTournamentPayload,
  buildApiFootballLivePayload,
  buildApiFootballStandingsPayload,
  classifyApiFootballProviderError,
  createApiFootballWatcher,
  fetchApiFootballFixtures,
  fetchApiFootballLiveFixtures,
  fetchApiFootballSeasonStartDate,
  fetchApiFootballStandings,
  fetchApiFootballTeams,
  getSafeApiFootballProviderMessage,
  getApiFootballRefreshIntervalMs,
  hasApiFootballMatchWindow,
  normalizeApiFootballFeeds,
  shouldPollApiFootballFixtures,
} = require('../services/api-football');

describe('OpenLigaDB data formatting', () => {
  test('persists daily request counts for both providers and resets them on UTC day change', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bockis-api-usage-'));
    const filePath = path.join(directory, 'usage.json');
    let now = new Date('2026-11-11T23:59:00Z');
    try {
      const tracker = createApiUsageTracker({ filePath, nowProvider: () => now });
      tracker.recordApiRequest('openligadb');
      tracker.recordApiRequest('apiFootball');
      tracker.recordApiRequest('apiFootball');
      expect(tracker.getUsageSnapshot()).toEqual({
        dateUtc: '2026-11-11',
        totalRequests: 3,
        providers: {
          openligadb: { requests: 1, dailyLimit: null, remaining: null },
          apiFootball: { requests: 2, dailyLimit: 100, remaining: 98 },
        },
      });

      const restoredTracker = createApiUsageTracker({ filePath, nowProvider: () => now });
      expect(restoredTracker.getUsageSnapshot().providers.apiFootball.requests).toBe(2);
      now = new Date('2026-11-12T00:00:00Z');
      expect(restoredTracker.getUsageSnapshot().providers.apiFootball.requests).toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('stops API-Football requests at the configured daily limit', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bockis-api-limit-'));
    try {
      const tracker = createApiUsageTracker({
        filePath: path.join(directory, 'usage.json'),
      });
      tracker.setDailyLimit('apiFootball', 1);
      expect(tracker.recordApiRequest('apiFootball')).toBe(true);
      expect(tracker.recordApiRequest('apiFootball')).toBe(false);
      expect(tracker.getUsageSnapshot().providers.apiFootball).toEqual({ requests: 1, dailyLimit: 1, remaining: 0 });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fetches API-Football fixtures with the key header and renders a local Discord countdown', async () => {
    const usageTracker = { recordApiRequest: jest.fn(() => true) };
    const http = { get: jest.fn(async () => ({ data: { response: [{
      fixture: { date: '2028-06-09T13:00:00+00:00', venue: { name: 'National Stadium of Wales', city: 'Cardiff' }, status: { short: 'NS' } },
      teams: { home: { name: 'Wales' }, away: { name: 'Opponent' } },
      league: { name: 'EURO 2028', round: 'Group A' },
    }] } })) };
    const fixtures = await fetchApiFootballFixtures(http, 'test-key', { leagueId: 4, season: 2028 }, usageTracker);
    expect(usageTracker.recordApiRequest).toHaveBeenCalledWith('apiFootball');
    expect(http.get.mock.calls[0][1].headers['x-apisports-key']).toBe('test-key');
    const embed = buildApiFootballTournamentPayload({ name: 'UEFA EURO 2028' }, fixtures, Date.parse('2028-06-01T00:00:00Z')).embeds[0].toJSON();
    expect(embed.description).toContain('<t:1844168400:R>');
    expect(embed.description).toContain('National Stadium of Wales · Cardiff');
  });

  test('keeps distant tournaments local and skips API polling until 30 days before kickoff', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const feed = { name: 'UEFA EURO 2028', startDate: '2028-06-09' };
    expect(shouldPollApiFootballFixtures(feed, now)).toBe(false);
    expect(shouldPollApiFootballFixtures({ startDate: '2026-01-15' }, now)).toBe(true);
    expect(getApiFootballRefreshIntervalMs({})).toBe(24 * 60 * 60 * 1000);
    const embed = buildApiFootballTournamentPayload(feed, [], now).embeds[0].toJSON();
    expect(embed.description).toContain('<t:1844121600:R>');
  });

  test('limits API-Football feeds to the requested tournament set and normalizes channel targets', () => {
    expect(API_FOOTBALL_COMPETITIONS.map(item => item.category)).toEqual([
      'Europameisterschaft', 'Qualifikation', 'Weltmeisterschaft',
      'Qualifikation', 'Qualifikation', 'Qualifikation', 'Qualifikation', 'Qualifikation', 'Qualifikation',
    ]);
    expect(normalizeApiFootballFeeds([{ leagueId: 4, season: 2028, channelId: '12345678901234567' }])).toEqual([{
      leagueId: 4,
      season: 2028,
      name: 'UEFA Europameisterschaft',
      liveChannelId: '12345678901234567',
      tableChannelId: '',
      notificationChannelId: '',
      countdownChannelId: '',
      startDate: '',
      updateIntervalMinutes: 1440,
      favoriteTeamIds: [],
      maxFavorites: 5,
      countdownTeamId: null,
      countdownStyle: 'classic',
      countdownColor: '#1C8C73',
      finishedMatchImage: {
        enabled: false,
        showScorers: true,
        showCompetition: true,
        showDate: false,
        template: 'stadium',
      },
    }]);
    expect(() => normalizeApiFootballFeeds([{ leagueId: 9999, season: 2030, liveChannelId: '12345678901234567' }])).toThrow('unterstützten Wettbewerb');
    expect(() => normalizeApiFootballFeeds([
      { leagueId: 4, season: 2028, liveChannelId: '12345678901234567' },
      { leagueId: 4, season: 2028, tableChannelId: '12345678901234568' },
    ])).toThrow('doppelt');
  });

  test('normalizes API-Football favorites, graphic settings, and countdown options', () => {
    const [feed] = normalizeApiFootballFeeds([{
      leagueId: 4,
      season: 2028,
      notificationChannelId: '12345678901234567',
      favoriteTeamIds: [11, 12, 11],
      maxFavorites: 2,
      countdownTeamId: 12,
      countdownStyle: 'graphic_timer',
      countdownColor: '#12AB34',
      finishedMatchImage: { enabled: true, showScorers: false, template: 'minimal' },
    }]);

    expect(feed.favoriteTeamIds).toEqual([11, 12]);
    expect(feed.countdownTeamId).toBe(12);
    expect(feed.countdownStyle).toBe('graphic_timer');
    expect(feed.finishedMatchImage).toEqual({
      enabled: true,
      showScorers: false,
      showCompetition: true,
      showDate: false,
      template: 'minimal',
    });
    expect(() => normalizeApiFootballFeeds([{
      leagueId: 4, season: 2028, notificationChannelId: '12345678901234567', favoriteTeamIds: [11, 12], maxFavorites: 1,
    }])).toThrow('höchstens 1 Favoriten');
  });

  test('formats a live match involving a selected API-Football favorite', () => {
    const payload = buildApiFootballFavoriteMatchPayload({
      name: 'UEFA Europameisterschaft', favoriteTeamIds: [11],
    }, {
      fixture: { status: { short: '1H', elapsed: 24 } },
      league: { id: 4, round: 'Group A' },
      teams: { home: { id: 11, name: 'Germany' }, away: { id: 12, name: 'France' } },
      goals: { home: 1, away: 0 },
    });

    expect(payload.embeds[0].toJSON().title).toContain('Germany');
    expect(payload.embeds[0].toJSON().description).toContain('Germany 1:0 France');
    expect(payload.embeds[0].toJSON().description).toContain('24. Minute');
  });

  test('posts an API-Football countdown for the selected favorite team', async () => {
    const now = Date.parse('2028-06-01T12:00:00Z');
    const channelId = '12345678901234567';
    const sent = [];
    const channel = {
      isTextBased: () => true,
      messages: { fetch: jest.fn(async () => []) },
      send: jest.fn(async payload => { sent.push(payload); return { author: { id: 'bot' }, embeds: payload.embeds }; }),
    };
    const http = { get: jest.fn(async () => ({ data: { response: [{
      fixture: { id: 101, date: new Date(now + 7 * 24 * 60 * 60_000).toISOString(), status: { short: 'NS' } },
      league: { id: 4, round: 'Group A' },
      teams: { home: { id: 11, name: 'Germany' }, away: { id: 12, name: 'France' } },
    }] } })) };
    const watcher = createApiFootballWatcher({
      http,
      client: { user: { id: 'bot' }, channels: { cache: new Map([[channelId, channel]]) } },
      logger: { warn: jest.fn(), info: jest.fn() },
      getApiKey: () => 'test-key',
      getFeeds: () => [{ leagueId: 4, season: 2028, countdownChannelId: channelId, favoriteTeamIds: [11], countdownTeamId: 11 }],
      nowProvider: () => now,
      usageTracker: { recordApiRequest: jest.fn(() => true) },
    });

    await watcher.checkOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0].embeds[0].toJSON().description).toContain('Germany');
  });

  test('sends one result graphic for a finished API-Football favorite match', async () => {
    const now = Date.parse('2028-06-10T12:00:00Z');
    const channelId = '12345678901234567';
    const channel = {
      isTextBased: () => true,
      messages: { fetch: jest.fn(async () => []) },
      send: jest.fn(async payload => payload),
    };
    const http = { get: jest.fn(async () => ({ data: { response: [{
      fixture: { id: 102, date: '2028-06-09T12:00:00Z', status: { short: 'FT' } },
      league: { id: 4, round: 'Group A' },
      teams: { home: { id: 11, name: 'Germany' }, away: { id: 12, name: 'France' } },
      goals: { home: 2, away: 1 },
    }] } })) };
    const watcher = createApiFootballWatcher({
      http,
      client: { user: { id: 'bot' }, channels: { cache: new Map([[channelId, channel]]) } },
      logger: { warn: jest.fn(), info: jest.fn() },
      getApiKey: () => 'test-key',
      getFeeds: () => [{
        leagueId: 4,
        season: 2028,
        notificationChannelId: channelId,
        favoriteTeamIds: [11],
        finishedMatchImage: { enabled: true, showScorers: false, template: 'minimal' },
      }],
      nowProvider: () => now,
      usageTracker: { recordApiRequest: jest.fn(() => true) },
    });

    await watcher.checkOnce();

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0][0].content).toContain('Germany 2:1 France');
    expect(channel.send.mock.calls[0][0].files[0].name).toContain('102');
  });

  test('fetches standings and shared live fixtures and formats both Discord embeds', async () => {
    const usageTracker = { recordApiRequest: jest.fn(() => true) };
    const http = { get: jest.fn(async (url) => ({ data: { response: url.endsWith('/standings') ? [{
      league: { standings: [[{
        rank: 1, team: { name: 'Germany' }, points: 9, all: { played: 3 }, goalsDiff: 6, group: 'Group A',
      }]] },
    }] : [{
      fixture: { date: '2028-06-09T13:00:00Z', status: { short: '1H', elapsed: 24 } },
      league: { id: 4, round: 'Group A' },
      teams: { home: { name: 'Germany' }, away: { name: 'France' } },
      goals: { home: 1, away: 0 },
    }] } })) };
    const feed = { leagueId: 4, season: 2028, name: 'UEFA Europameisterschaft' };
    const standings = await fetchApiFootballStandings(http, 'test-key', feed, usageTracker);
    const liveFixtures = await fetchApiFootballLiveFixtures(http, 'test-key', usageTracker);
    expect(http.get.mock.calls[0][1].params).toEqual({ league: 4, season: 2028 });
    expect(http.get.mock.calls[1][1].params).toEqual({ live: 'all' });
    expect(usageTracker.recordApiRequest).toHaveBeenCalledTimes(2);
    expect(buildApiFootballStandingsPayload(feed, standings).embeds[0].toJSON().fields[0].value).toContain('Germany');
    expect(buildApiFootballLivePayload(feed, liveFixtures).embeds[0].toJSON().description).toContain('Germany 1:0 France');
    expect(hasApiFootballMatchWindow(liveFixtures, Date.parse('2028-06-09T13:20:00Z'))).toBe(true);
  });

  test('fetches the tournament start date from the matching API-Football season metadata', async () => {
    const usageTracker = { recordApiRequest: jest.fn(() => true) };
    const http = { get: jest.fn(async () => ({ data: { response: [{
      league: { id: 4 },
      seasons: [
        { year: 2024, start: '2024-06-14', end: '2024-07-14' },
        { year: 2028, start: '2028-06-09', end: '2028-07-09' },
      ],
    }] } })) };

    const startDate = await fetchApiFootballSeasonStartDate(http, 'test-key', { leagueId: 4, season: 2028 }, usageTracker);

    expect(http.get).toHaveBeenCalledWith('https://v3.football.api-sports.io/leagues', expect.objectContaining({
      params: { id: 4, season: 2028 },
    }));
    expect(startDate).toBe('2028-06-09');
    expect(usageTracker.recordApiRequest).toHaveBeenCalledWith('apiFootball');
  });

  test('loads and sorts teams for an API-Football tournament feed', async () => {
    const usageTracker = { recordApiRequest: jest.fn(() => true) };
    const http = { get: jest.fn(async () => ({ data: { response: [
      { team: { id: 2, name: 'Wales', code: 'WAL' } },
      { team: { id: 1, name: 'Germany', code: 'GER' } },
      { team: { id: 0, name: 'Invalid' } },
    ] } })) };

    const teams = await fetchApiFootballTeams(http, 'test-key', { leagueId: 4, season: 2028 }, usageTracker);

    expect(http.get.mock.calls[0][0]).toContain('/teams');
    expect(http.get.mock.calls[0][1].params).toEqual({ league: 4, season: 2028 });
    expect(teams).toEqual([
      { teamId: 1, teamName: 'Germany', shortName: 'GER' },
      { teamId: 2, teamName: 'Wales', shortName: 'WAL' },
    ]);
    expect(usageTracker.recordApiRequest).toHaveBeenCalledWith('apiFootball');
  });

  test('classifies an API-Football key rejection when loading teams', async () => {
    const usageTracker = { recordApiRequest: jest.fn(() => true) };
    const http = { get: jest.fn(async () => ({ data: { errors: { token: 'Invalid API key' }, response: [] } })) };

    await expect(fetchApiFootballTeams(http, 'invalid-key', { leagueId: 4, season: 2028 }, usageTracker))
      .rejects.toMatchObject({ code: 'API_FOOTBALL_AUTH' });
  });

  test('shows provider error details while redacting the API key', () => {
    const apiKey = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const message = getSafeApiFootballProviderMessage({
      response: { data: { errors: { token: `Invalid key ${apiKey}` } } },
    }, apiKey);

    expect(message).toContain('Invalid key [Schlüssel verborgen]');
    expect(message).not.toContain(apiKey);
  });

  test.each([
    [{ token: 'Invalid API key' }, 'key'],
    [{ subscription: 'You are not subscribed to this API' }, 'subscription'],
    [{ ip: 'This IP is not allowed to call the API' }, 'restriction'],
  ])('classifies provider access errors without returning their raw details', (providerErrors, expected) => {
    expect(classifyApiFootballProviderError({ providerErrors })).toBe(expected);
  });

  test('refreshes configured standings before the distant tournament fixture window', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const standings = Array.from({ length: 10 }, (_, groupIndex) => Array.from({ length: 20 }, (_, teamIndex) => ({
      rank: teamIndex + 1,
      team: { name: `Group ${groupIndex + 1} Team ${teamIndex + 1} with an intentionally long name` },
      points: 20 - teamIndex,
      all: { played: 10 },
      goalsDiff: 20 - teamIndex,
      group: `Group ${groupIndex + 1}`,
    })));
    const http = { get: jest.fn(async () => ({ data: { response: [{ league: { standings } }] } })) };
    const channel = {
      isTextBased: () => true,
      messages: { fetch: jest.fn(async () => []) },
      send: jest.fn(async payload => ({ ...payload })),
    };
    const watcher = createApiFootballWatcher({
      http,
      client: { user: { id: 'bot' }, channels: { cache: new Map([['12345678901234567', channel]]) } },
      logger: { warn: jest.fn(), info: jest.fn() },
      getApiKey: () => 'test-key',
      getFeeds: () => [{ leagueId: 4, season: 2028, name: 'UEFA Europameisterschaft', startDate: '2028-06-09', tableChannelId: '12345678901234567' }],
      nowProvider: () => now,
    });

    await watcher.checkOnce();

    expect(http.get).toHaveBeenCalledTimes(1);
    expect(http.get.mock.calls[0][0]).toContain('/standings');
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
      embeds: [expect.objectContaining({ data: expect.objectContaining({ title: expect.stringContaining('Tabelle') }) })],
    }));
    const embed = channel.send.mock.calls[0][0].embeds[0].toJSON();
    const characterCount = (embed.title || '').length + (embed.description || '').length
      + (embed.footer?.text || '').length + (embed.author?.name || '').length
      + (embed.fields || []).reduce((total, field) => total + field.name.length + field.value.length, 0);
    expect(characterCount).toBeLessThanOrEqual(6000);
    expect(embed.fields.length).toBeLessThanOrEqual(25);
    expect(embed.fields.every(field => field.name.length <= 256 && field.value.length <= 1024)).toBe(true);
  });

  test('uses one shared live fixture request only when matches are within three hours', async () => {
    let now = Date.parse('2026-01-01T12:00:00Z');
    const kickoff = now + 4 * 60 * 60_000;
    const http = { get: jest.fn(async (_url, { params }) => {
      if (params.live === 'all') return { data: { response: [{
        fixture: { date: new Date(now).toISOString(), status: { short: '1H', elapsed: 10 } },
        league: { id: 4 },
        teams: { home: { name: 'Germany' }, away: { name: 'France' } },
        goals: { home: 1, away: 0 },
      }] } };
      return { data: { response: [{
        fixture: { date: new Date(kickoff).toISOString(), status: { short: 'NS' } },
        league: { id: params.league },
        teams: { home: { name: 'Home' }, away: { name: 'Away' } },
      }] } };
    }) };
    const channelIds = ['12345678901234567', '12345678901234568'];
    const channels = new Map(channelIds.map(id => [id, {
      isTextBased: () => true,
      messages: { fetch: jest.fn(async () => []) },
      send: jest.fn(async payload => {
        const message = {
          author: { id: 'bot' },
          embeds: payload.embeds,
          edit: jest.fn(async updated => {
            message.embeds = updated.embeds;
            return message;
          }),
        };
        return message;
      }),
    }]));
    const watcher = createApiFootballWatcher({
      http,
      client: { user: { id: 'bot' }, channels: { cache: channels } },
      logger: { warn: jest.fn(), info: jest.fn() },
      getApiKey: () => 'test-key',
      getFeeds: () => [
        { leagueId: 4, season: 2028, liveChannelId: channelIds[0], updateIntervalMinutes: 60 },
        { leagueId: 1, season: 2030, liveChannelId: channelIds[1], updateIntervalMinutes: 60 },
      ],
      nowProvider: () => now,
      usageTracker: { recordApiRequest: jest.fn(() => true) },
    });

    await watcher.checkOnce();
    expect(http.get.mock.calls.filter(([, options]) => options.params.live === 'all')).toHaveLength(0);

    now += 61 * 60_000;
    await watcher.checkOnce();
    expect(http.get.mock.calls.filter(([, options]) => options.params.live === 'all')).toHaveLength(1);
  });

  test('resolves latest season for the selected league', () => {
    const leagues = [
      { leagueShortcut: 'bl1', leagueSeason: '2024' },
      { leagueShortcut: 'bl1', leagueSeason: '2026' },
      { leagueShortcut: 'bl2', leagueSeason: '2027' },
    ];
    expect(getSeasonForLeague(leagues, 'bl1')).toBe(2026);
  });

  test('lists only selected current competitions and deduplicates aliases', () => {
    const leagues = getAvailableFootballLeagues([
      { leagueShortcut: '1. Fußball-Bundesliga 2007/2008', leagueSeason: '2007', leagueName: '1. Fußball-Bundesliga', sport: { sportId: 1 } },
      { leagueShortcut: 'bl1', leagueSeason: '2025', leagueName: 'Bundesliga', sport: { sportId: 1 } },
      { leagueShortcut: 'bl1', leagueSeason: '2026', leagueName: 'Bundesliga', sport: { sportId: 1 } },
      { leagueShortcut: 'bl2', leagueSeason: '2026', leagueName: '2. Fußball-Bundesliga 2026/2027', sport: { sportId: 1 } },
      { leagueShortcut: 'bl2h', leagueSeason: '2026', leagueName: '2. Bundesliga 2026/27 (Herren)', sport: { sportId: 1 } },
      { leagueShortcut: 'bl3', leagueSeason: '2026', leagueName: '3. Liga 2026/2027', sport: { sportId: 1 } },
      { leagueShortcut: 'ucl', leagueSeason: '2026', leagueName: 'Champions League 2026/2027', sport: { sportId: 1 } },
      { leagueShortcut: 'ucl2026', leagueSeason: '2026', leagueName: 'Champions League 2026/27', sport: { sportId: 1 } },
      { leagueShortcut: 'dfb', leagueSeason: '2026', leagueName: 'DFB Pokal 2026/2027', sport: { sportId: 1 } },
      { leagueShortcut: 'pl', leagueSeason: '2026', leagueName: 'Premier League England', sport: { sportId: 1 } },
      { leagueShortcut: 'bl1test', leagueSeason: '2026', leagueName: 'Bundesliga', sport: { sportId: 1 } },
      { leagueShortcut: 'ffb1', leagueSeason: '2026', leagueName: '1. Frauen Fußballbundesliga', sport: { sportId: 1 } },
      { leagueShortcut: 'dfbf', leagueSeason: '2026', leagueName: 'DFB-Pokal Frauen', sport: { sportId: 1 } },
      { leagueShortcut: 'cup', leagueSeason: '2026', leagueName: 'Pokal', sport: { sportId: 2 } },
    ], new Date('2026-11-09T12:00:00Z'));

    expect(leagues.map(league => league.leagueShortcut).sort()).toEqual(['bl1', 'bl2', 'bl3', 'dfb', 'ucl']);
    expect(leagues.find(league => league.leagueShortcut === 'bl2').leagueSeason).toBe(2026);
    expect(leagues.find(league => league.leagueShortcut === 'bl2').leagueName).toBe('2. Fußball-Bundesliga 2026/2027');
    expect(leagues.find(league => league.leagueShortcut === 'ucl').leagueName).toBe('Champions League 2026/2027');
    expect(leagues.find(league => league.leagueShortcut === 'dfb').leagueSeason).toBe(2026);
  });

  test('includes latest and upcoming international tournaments and DFB national teams', () => {
    const leagues = getAvailableFootballLeagues([
      { leagueShortcut: 'em2020', leagueSeason: '2020', leagueName: 'Europameisterschaft 2020', sport: { sportId: 1 } },
      { leagueShortcut: 'em', leagueSeason: '2024', leagueName: 'UEFA EURO 2024', sport: { sportId: 1 } },
      { leagueShortcut: 'em2024', leagueSeason: '2024', leagueName: 'Europameisterschaft 2024', sport: { sportId: 1 } },
      { leagueShortcut: 'em2024mitKarten', leagueSeason: '2024', leagueName: 'UEFA Euro 2024 mit Karten', sport: { sportId: 1 } },
      { leagueShortcut: 'em2028', leagueSeason: '2028', leagueName: 'Europameisterschaft 2028', sport: { sportId: 1 } },
      { leagueShortcut: 'wm2022', leagueSeason: '2022', leagueName: 'WM 2022', sport: { sportId: 1 } },
      { leagueShortcut: 'wm26', leagueSeason: '2026', leagueName: 'WM 2026', sport: { sportId: 1 } },
      { leagueShortcut: 'wm2026', leagueSeason: '2026', leagueName: 'WM 2026 USA', sport: { sportId: 1 } },
      { leagueShortcut: 'wm2026_xlife', leagueSeason: '2026', leagueName: 'FIFA World Cup 2026', sport: { sportId: 1 } },
      { leagueShortcut: 'wm_mueller', leagueSeason: '2026', leagueName: 'WM2026', sport: { sportId: 1 } },
      { leagueShortcut: 'wm30', leagueSeason: '2030', leagueName: 'WM 2030', sport: { sportId: 1 } },
      { leagueShortcut: 'fef2025', leagueSeason: '2025', leagueName: 'Fußball-Europameisterschaft der Frauen 2025', sport: { sportId: 1 } },
      { leagueShortcut: 'DFBNAT2526', leagueSeason: '2025', leagueName: 'Deutsche Fußballnationalmannschaft-Spiele 25/26', sport: { sportId: 1 } },
      { leagueShortcut: 'DFBN', leagueSeason: '2026', leagueName: 'DFB Nationalspiele', sport: { sportId: 1 } },
      { leagueShortcut: 'fna', leagueSeason: '2026', leagueName: 'Frauen-Nationalmannschaft', sport: { sportId: 1 } },
      { leagueShortcut: 'u21dfb', leagueSeason: '2026', leagueName: 'DFB U21', sport: { sportId: 1 } },
      { leagueShortcut: 'u21test', leagueSeason: '2026', leagueName: 'UEFA U21 Championship', sport: { sportId: 1 } },
    ], new Date('2026-11-09T12:00:00Z'));
    const shortcuts = leagues.map(league => league.leagueShortcut);

    expect(shortcuts).toEqual(expect.arrayContaining(['em2024', 'em2028', 'wm26', 'wm30', 'DFBN', 'fna', 'u21dfb']));
    for (const excludedShortcut of ['em', 'em2020', 'em2024mitKarten', 'wm2022', 'wm2026', 'wm2026_xlife', 'wm_mueller', 'fef2025', 'DFBNAT2526', 'u21test']) {
      expect(shortcuts).not.toContain(excludedShortcut);
    }
  });

  test('includes current Europa League, Conference League, and Nations League entries', () => {
    const leagues = getAvailableFootballLeagues([
      { leagueShortcut: 'uel2024', leagueSeason: '2024', leagueName: 'Europa League 2024/25', sport: { sportId: 1 } },
      { leagueShortcut: 'uel2026', leagueSeason: '2026', leagueName: 'Europa League 2026/27', sport: { sportId: 1 } },
      { leagueShortcut: 'uel', leagueSeason: '2026', leagueName: 'Europa League 2026/27', sport: { sportId: 1 } },
      { leagueShortcut: 'uel-test', leagueSeason: '2026', leagueName: 'Europa League unused', sport: { sportId: 1 } },
      { leagueShortcut: 'uecl2023', leagueSeason: '2023', leagueName: 'UEFA Europa Conference League 2023', sport: { sportId: 1 } },
      { leagueShortcut: 'uecl2026', leagueSeason: '2026', leagueName: 'Conference League 2026/27', sport: { sportId: 1 } },
      { leagueShortcut: 'uecl', leagueSeason: '2026', leagueName: 'Conference League 2026/27', sport: { sportId: 1 } },
      { leagueShortcut: 'unl2024', leagueSeason: '2024', leagueName: 'Nations League 2024/25 (DE)', sport: { sportId: 1 } },
      { leagueShortcut: 'unl', leagueSeason: '2026', leagueName: 'Nations League 2026/27', sport: { sportId: 1 } },
      { leagueShortcut: 'nla', leagueSeason: '2026', leagueName: 'Nations League A 2026', sport: { sportId: 1 } },
    ], new Date('2026-11-09T12:00:00Z'));
    const shortcuts = leagues.map(league => league.leagueShortcut);

    expect(shortcuts.sort()).toEqual(['uecl2026', 'uel2026', 'unl']);
    for (const excludedShortcut of ['uel2024', 'uel', 'uel-test', 'uecl2023', 'uecl', 'unl2024', 'nla']) {
      expect(shortcuts).not.toContain(excludedShortcut);
    }
  });

  test('limits favorite teams to the configured maximum', () => {
    expect(getFavoriteTeamIds({ favoriteTeamIds: [40, 7, 40], maxFavorites: 1 })).toEqual([40]);
  });

  test('uses a safe one-minute default and supports per-feed update intervals', () => {
    expect(getOpenLigaDbUpdateIntervalMs({})).toBe(60_000);
    expect(getOpenLigaDbUpdateIntervalMs({ updateIntervalMinutes: 5 })).toBe(300_000);
    expect(getOpenLigaDbUpdateIntervalMs({ updateIntervalMinutes: 61 })).toBe(60_000);
  });

  test('uses the latest goal score and distinguishes live from finished games', () => {
    const match = {
      matchIsFinished: false,
      matchDateTimeUTC: '2026-11-07T14:30:00Z',
      matchResults: [{ resultTypeKind: 'HalfTime', pointsTeam1: 1, pointsTeam2: 0, resultOrderID: 1 }],
      goals: [
        { matchMinute: 12, scoreTeam1: 1, scoreTeam2: 0 },
        { matchMinute: 64, scoreTeam1: 1, scoreTeam2: 1 },
      ],
    };
    expect(getMatchScore(match)).toEqual([1, 1]);
    expect(getMatchStatus(match, Date.parse('2026-11-07T15:40:00Z'))).toBe('Läuft');
    expect(getMatchStatus({ ...match, matchIsFinished: true })).toBe('Beendet');
  });

  test('includes only matches involving a favorite and adds data attribution', () => {
    const payload = buildScoreboardPayload({
      group: { groupName: '9. Spieltag' },
      favoriteTeamIds: [40],
      now: Date.parse('2026-11-07T14:00:00Z'),
      matches: [
        { team1: { teamId: 40, shortName: 'Bayern' }, team2: { teamId: 7, shortName: 'Dortmund' }, goals: [{ matchMinute: 20, scoreTeam1: 1, scoreTeam2: 0, goalGetterName: 'Spieler' }] },
        { team1: { teamId: 80, shortName: 'Union' }, team2: { teamId: 6, shortName: 'Leverkusen' }, goals: [] },
      ],
    });

    const embed = payload.embeds[0].toJSON();

    expect(embed.fields).toHaveLength(1);
    expect(embed.fields[0].name).toContain('Bayern');
    expect(embed.footer.text).toContain('ODbL 1.0');
  });

  test('renders a finished-match graphic as a PNG', async () => {
    const png = await buildFinishedMatchPng({
      leagueName: '1. Bundesliga',
      group: { groupName: '9. Spieltag' },
      match: {
        matchDateTimeUTC: '2026-11-10T18:30:00Z',
        team1: { shortName: 'FC Beispiel' },
        team2: { shortName: 'SV Muster' },
        goals: [{ goalGetterName: 'Max Beispiel', matchMinute: 88, scoreTeam1: 3, scoreTeam2: 2 }],
      },
      settings: { showScorers: true, showCompetition: true, showDate: true, template: 'classic' },
    });

    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  test('renders a goal event graphic as a PNG', async () => {
    const png = await buildGoalEventPng({
      leagueName: '1. Bundesliga',
      group: { groupName: '10. Spieltag' },
      match: {
        goals: [{ scoreTeam1: 2, scoreTeam2: 1 }],
        team1: { shortName: 'FC Beispiel' },
        team2: { shortName: 'SV Muster' },
      },
      goal: { goalGetterName: 'Max Beispiel', matchMinute: 67, scoreTeam1: 2, scoreTeam2: 1 },
      color: '#123456',
    });

    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  test('builds a dynamic Discord countdown for the selected favorite team', () => {
    const payload = buildNextMatchCountdownPayload({
      leagueName: '1. Bundesliga',
      teamId: 40,
      match: {
        matchDateTimeUTC: '2026-11-20T19:30:00Z',
        group: { groupName: '10. Spieltag' },
        team1: { teamId: 40, shortName: 'Bayern' },
        team2: { teamId: 65, shortName: 'Köln' },
      },
      now: Date.parse('2026-11-10T12:00:00Z'),
    });

    expect(payload.embeds[0].toJSON().title).toContain('Bayern');
    expect(payload.embeds[0].toJSON().description).toContain('Bayern · Köln');
    expect(payload.embeds[0].toJSON().description).toContain('<t:1795203000:R>');
  });

  test('shows a live days-hours-minutes timer that decreases over time', () => {
    const match = {
      matchDateTimeUTC: '2026-11-20T19:30:00Z',
      team1: { teamId: 40, shortName: 'Bayern' },
      team2: { teamId: 65, shortName: 'Köln' },
    };
    const initial = buildNextMatchCountdownPayload({
      leagueName: '1. Bundesliga',
      teamId: 40,
      countdownStyle: 'live_timer',
      match,
      now: Date.parse('2026-11-10T12:00:00Z'),
    });
    const afterMinute = buildNextMatchCountdownPayload({
      leagueName: '1. Bundesliga',
      teamId: 40,
      countdownStyle: 'live_timer',
      match,
      now: Date.parse('2026-11-10T12:01:00Z'),
    });

    expect(initial.embeds[0].toJSON().description).toContain('Noch 10 Tage · 7 Std. · 30 Min.');
    expect(afterMinute.embeds[0].toJSON().description).toContain('Noch 10 Tage · 7 Std. · 29 Min.');
  });

  test('renders the SVG-based countdown graphic as a colored Discord PNG embed', async () => {
    const options = {
      leagueName: '1. Bundesliga',
      teamId: 40,
      countdownStyle: 'graphic_timer',
      countdownColor: '#123456',
      match: {
        matchDateTimeUTC: '2026-11-20T19:30:00Z',
        team1: { teamId: 40, shortName: 'Bayern' },
        team2: { teamId: 65, shortName: 'Köln' },
      },
      now: Date.parse('2026-11-10T12:00:00Z'),
    };
    const payload = await buildNextMatchCountdownMessage(options);
    const png = await buildNextMatchCountdownPng(options);

    expect(payload.embeds[0].toJSON().color).toBe(0x123456);
    expect(payload.embeds[0].toJSON().image.url).toBe(
      `attachment://openligadb-countdown-${Math.floor(options.now / 60_000)}.png`,
    );
    expect(payload.embeds[0].toJSON().description).toBe('\u200b');
    expect(payload.files[0].attachment.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png).toEqual(payload.files[0].attachment);
    expect(getDefaultCountdownColor('uel')).toBe('#F1C40F');
  });

  test('provides twelve distinct countdown embed variants', () => {
    const payloads = OPENLIGADB_COUNTDOWN_STYLES.map(countdownStyle => buildNextMatchCountdownPayload({
      leagueName: '1. Bundesliga',
      teamId: 40,
      countdownStyle,
      match: {
        matchDateTimeUTC: '2026-11-20T19:30:00Z',
        group: { groupName: '10. Spieltag' },
        team1: { teamId: 40, shortName: 'Bayern' },
        team2: { teamId: 65, shortName: 'Köln' },
      },
      now: Date.parse('2026-11-10T12:00:00Z'),
    }));

    expect(OPENLIGADB_COUNTDOWN_STYLES).toHaveLength(12);
    expect(new Set(payloads.map(payload => JSON.stringify(payload.embeds[0].toJSON()))).size).toBe(12);
  });

  test('adds in-progress scores to the official table as provisional standings', () => {
    const payload = buildLiveTablePayload({
      leagueName: '1. Bundesliga',
      now: Date.parse('2026-11-07T15:00:00Z'),
      table: [
        { teamId: 40, teamName: 'FC Bayern München', shortName: 'Bayern', points: 10, goals: 10, opponentGoals: 5, matches: 5, won: 3, draw: 1, lost: 1 },
        { teamId: 7, teamName: 'Borussia Dortmund', shortName: 'Dortmund', points: 9, goals: 8, opponentGoals: 5, matches: 5, won: 3, draw: 0, lost: 2 },
      ],
      matches: [{
        matchIsFinished: false,
        matchDateTimeUTC: '2026-11-07T14:30:00Z',
        team1: { teamId: 40 },
        team2: { teamId: 7 },
        goals: [{ matchMinute: 20, scoreTeam1: 1, scoreTeam2: 0 }],
      }],
    });
    const description = payload.embeds[0].toJSON().description;

    expect(description).toContain('Bayern · 13 P · 11:5');
    expect(description).toContain('Dortmund · 9 P · 8:6');
  });

  test('shows only teams still in the DFB Pokal instead of league standings', () => {
    const payload = buildLiveTablePayload({
      leagueShortcut: 'dfb',
      leagueName: 'DFB Pokal 2026/2027',
      group: { groupName: '2. Runde' },
      table: [
        { teamId: 1, teamName: 'Eintracht Frankfurt' },
        { teamId: 2, teamName: 'SC St. Tönis' },
        { teamId: 3, teamName: 'Bayern München' },
        { teamId: 4, teamName: 'Dynamo Dresden' },
        { teamId: 5, teamName: 'Borussia Dortmund' },
        { teamId: 6, teamName: 'Bayer Leverkusen' },
      ],
      matches: [
        {
          matchIsFinished: true,
          team1: { teamId: 1, teamName: 'Eintracht Frankfurt' },
          team2: { teamId: 2, teamName: 'SC St. Tönis' },
          matchResults: [{ resultTypeKind: 'After90Minutes', pointsTeam1: 2, pointsTeam2: 0 }],
        },
        {
          matchIsFinished: false,
          team1: { teamId: 3, teamName: 'Bayern München' },
          team2: { teamId: 4, teamName: 'Dynamo Dresden' },
        },
        {
          matchIsFinished: true,
          team1: { teamId: 5, teamName: 'Borussia Dortmund' },
          team2: { teamId: 6, teamName: 'Bayer Leverkusen' },
          matchResults: [
            { resultTypeKind: 'After90Minutes', pointsTeam1: 1, pointsTeam2: 1 },
            { resultTypeKind: 'AfterPenalties', pointsTeam1: 4, pointsTeam2: 5 },
          ],
          goals: [{ matchMinute: 90, scoreTeam1: 1, scoreTeam2: 1 }],
        },
      ],
    });
    const embed = payload.embeds[0].toJSON();

    expect(embed.title).toContain('Noch vertreten');
    expect(embed.description).toContain('4 Mannschaften noch im Wettbewerb');
    expect(embed.description).toContain('Eintracht Frankfurt');
    expect(embed.description).toContain('Bayern München');
    expect(embed.description).toContain('Dynamo Dresden');
    expect(embed.description).toContain('Bayer Leverkusen');
    expect(embed.description).not.toContain('SC St. Tönis');
    expect(embed.description).not.toContain('Borussia Dortmund');
    expect(embed.description).not.toContain(' P · ');
  });

  test('loads all DFB Pokal matches for its remaining-teams table', async () => {
    const allMatches = [{
      matchIsFinished: true,
      team1: { teamId: 1, teamName: 'Sieger FC' },
      team2: { teamId: 2, teamName: 'Ausgeschieden 04' },
      matchResults: [{ resultTypeKind: 'After90Minutes', pointsTeam1: 2, pointsTeam2: 0 }],
    }];
    const http = { get: jest.fn(async url => {
      if (url.endsWith('/getavailableleagues')) return { data: [{
        leagueId: 4945,
        leagueShortcut: 'dfb',
        leagueSeason: '2026',
        leagueName: 'DFB Pokal 2026/2027',
        sport: { sportId: 1 },
      }] };
      if (url.endsWith('/getcurrentgroup/dfb')) return { data: { groupName: '2. Runde', groupOrderID: 2 } };
      if (url.includes('/getlastchangedate/')) return { data: '2026-11-10T12:00:00Z' };
      if (url.endsWith('/getmatchdata/dfb/2026/2')) return { data: [] };
      if (url.endsWith('/getmatchdata/dfb/2026')) return { data: allMatches };
      if (url.endsWith('/getbltable/dfb/2026')) return { data: [
        { teamId: 1, teamName: 'Sieger FC' },
        { teamId: 2, teamName: 'Ausgeschieden 04' },
        { teamId: 3, teamName: 'Noch Dabei SV' },
      ] };
      throw new Error(`Unexpected URL: ${url}`);
    }) };
    const channel = {
      isTextBased: () => true,
      messages: { fetch: jest.fn(async () => []) },
      send: jest.fn(async payload => payload),
    };
    const watcher = createOpenLigaDbWatcher({
      http,
      client: { user: { id: 'bot' }, channels: { cache: new Map([['table-channel', channel]]) } },
      ServerProfile: { findAll: async () => [{ guildId: 'guild', settingsJson: JSON.stringify({
        DISCORD_OPENLIGADB_ENABLED: true,
        DISCORD_OPENLIGADB_FEEDS: JSON.stringify([{
          leagueShortcut: 'dfb',
          season: 2026,
          favoriteTeamIds: [],
          tableChannelIds: ['table-channel'],
        }]),
      }) }] },
      logger: { warn: jest.fn(), info: jest.fn() },
      requestIntervalMs: 0,
    });

    await watcher.checkOnce();
    const tablePayload = channel.send.mock.calls[0][0];
    const description = tablePayload.embeds[0].toJSON().description;

    expect(http.get).toHaveBeenCalledWith(
      'https://api.openligadb.de/getmatchdata/dfb/2026',
      expect.any(Object),
    );
    expect(description).toContain('Sieger FC');
    expect(description).toContain('Noch Dabei SV');
    expect(description).not.toContain('Ausgeschieden 04');
  });

  test('loads the latest league season and normalizes its teams', async () => {
    const http = { get: jest.fn(async url => {
      if (url.endsWith('/getavailableleagues')) {
        return { data: [
          { leagueShortcut: 'bl1', leagueSeason: '2025', sport: { sportId: 1 } },
          { leagueShortcut: 'bl1', leagueSeason: '2026', sport: { sportId: 1 } },
        ] };
      }
      return { data: [
        { teamId: 7, teamName: 'Borussia Dortmund', shortName: 'Dortmund' },
        { teamId: 40, teamName: 'FC Bayern München', shortName: 'Bayern' },
      ] };
    }) };

    const league = await fetchLatestLeagueTeams(http, 'bl1', null, 0);

    expect(league.season).toBe(2026);
    expect(league.teams.map(team => team.teamId)).toEqual([7, 40]);
    expect(http.get.mock.calls[1][0]).toContain('/getavailableteams/bl1/2026');
  });

  test('polls each feed only after its configured interval', async () => {
    let now = Date.now();
    const http = { get: jest.fn(async url => {
      if (url.endsWith('/getavailableleagues')) return { data: [{ leagueShortcut: 'bl1', leagueSeason: '2026', leagueName: '1. Bundesliga', sport: { sportId: 1 } }] };
      if (url.endsWith('/getcurrentgroup/bl1')) return { data: { groupName: '9. Spieltag', groupOrderID: 9 } };
      if (url.includes('/getlastchangedate/')) return { data: '2026-11-07T14:00:00Z' };
      if (url.includes('/getmatchdata/')) return { data: [] };
      if (url.includes('/getbltable/')) return { data: [] };
      throw new Error(`Unexpected URL: ${url}`);
    }) };
    const watcher = createOpenLigaDbWatcher({
      http,
      client: { channels: { cache: new Map() } },
      ServerProfile: { findAll: async () => [{ guildId: 'guild', settingsJson: JSON.stringify({
        DISCORD_OPENLIGADB_ENABLED: true,
        DISCORD_OPENLIGADB_FEEDS: JSON.stringify([{
          leagueShortcut: 'bl1',
          updateIntervalMinutes: 5,
          favoriteTeamIds: [],
          tableChannelIds: [],
        }]),
      }) }] },
      logger: { warn: jest.fn(), info: jest.fn() },
      requestIntervalMs: 0,
      nowProvider: () => now,
    });

    await watcher.checkOnce();
    expect(http.get.mock.calls.filter(([url]) => url.endsWith('/getcurrentgroup/bl1'))).toHaveLength(1);

    await watcher.checkOnce();
    expect(http.get.mock.calls.filter(([url]) => url.endsWith('/getcurrentgroup/bl1'))).toHaveLength(1);

    now += 4 * 60_000;
    await watcher.checkOnce();
    expect(http.get.mock.calls.filter(([url]) => url.endsWith('/getcurrentgroup/bl1'))).toHaveLength(1);

    now += 60_000;
    await watcher.checkOnce();
    expect(http.get.mock.calls.filter(([url]) => url.endsWith('/getcurrentgroup/bl1'))).toHaveLength(2);
  });

  test('updates one countdown message and removes duplicate marked posts', async () => {
    let now = Date.parse('2026-11-10T12:00:00Z');
    let nextMatch = {
      matchDateTimeUTC: '2026-11-20T19:30:00Z',
      group: { groupName: '10. Spieltag' },
      team1: { teamId: 40, teamName: 'FC Bayern München', shortName: 'Bayern' },
      team2: { teamId: 65, teamName: '1. FC Köln', shortName: 'Köln' },
    };
    const http = { get: jest.fn(async url => {
      if (url.endsWith('/getavailableleagues')) return { data: [{
        leagueId: 4937,
        leagueShortcut: 'bl1',
        leagueSeason: '2026',
        leagueName: '1. Fußball-Bundesliga 2026/2027',
        sport: { sportId: 1 },
      }] };
      if (url.endsWith('/getcurrentgroup/bl1')) return { data: { groupName: '9. Spieltag', groupOrderID: 9 } };
      if (url.includes('/getlastchangedate/')) return { data: '2026-11-10T11:00:00Z' };
      if (url.includes('/getmatchdata/')) return { data: [] };
      if (url.includes('/getbltable/')) return { data: [{ teamId: 40, teamName: 'FC Bayern München', shortName: 'Bayern' }] };
      if (url.endsWith('/getnextmatchbyleagueteam/4937/40')) return { data: nextMatch };
      throw new Error(`Unexpected URL: ${url}`);
    }) };
    const countdownMessage = {
      author: { id: 'bot' },
      embeds: [{ footer: { text: 'OpenLigaDB · OpenLigaDB-Countdown:old-guild:bl1:2026' } }],
      edit: jest.fn(async () => countdownMessage),
      delete: jest.fn(),
    };
    const duplicateCountdownMessage = {
      author: { id: 'bot' },
      embeds: [{ footer: { text: 'OpenLigaDB · OpenLigaDB-Countdown:another-guild:bl1:2026' } }],
      delete: jest.fn(),
    };
    const channel = {
      isTextBased: () => true,
      messages: { fetch: jest.fn(async () => []) },
      send: jest.fn(async () => countdownMessage),
    };
    const countdownChannel = {
      isTextBased: () => true,
      messages: { fetch: jest.fn(async () => [countdownMessage, duplicateCountdownMessage]) },
      send: jest.fn(async () => countdownMessage),
    };
    const watcher = createOpenLigaDbWatcher({
      http,
      client: { user: { id: 'bot' }, channels: { cache: new Map([['channel', channel], ['countdown-channel', countdownChannel]]) } },
      ServerProfile: { findAll: async () => [{ guildId: 'guild', settingsJson: JSON.stringify({
        DISCORD_OPENLIGADB_ENABLED: true,
        DISCORD_OPENLIGADB_FEEDS: JSON.stringify([{
          leagueShortcut: 'bl1',
          season: 2026,
          favoriteTeamIds: [40],
          countdownTeamId: 40,
          notificationChannelId: 'channel',
          countdownChannelId: 'countdown-channel',
          tableChannelIds: [],
        }]),
      }) }] },
      logger: { warn: jest.fn(), info: jest.fn() },
      requestIntervalMs: 0,
      nowProvider: () => now,
    });

    await watcher.checkOnce();
    const countdownPayload = countdownMessage.edit.mock.calls[0][0];
    expect(countdownPayload.embeds[0].toJSON().description).toContain('<t:1795203000:R>');
    expect(channel.send.mock.calls.some(([payload]) => payload?.embeds?.[0]?.data?.title?.startsWith('⏳ Nächstes Spiel'))).toBe(false);
    expect(countdownChannel.send).not.toHaveBeenCalled();
    expect(duplicateCountdownMessage.delete).toHaveBeenCalledTimes(1);
    expect(http.get.mock.calls.some(([url]) => url.endsWith('/getnextmatchbyleagueteam/4937/40'))).toBe(true);

    await watcher.checkOnce();
    expect(countdownChannel.send).not.toHaveBeenCalled();
    nextMatch = {
      ...nextMatch,
      matchDateTimeUTC: '2026-11-27T19:30:00Z',
      team2: { teamId: 7, teamName: 'Borussia Dortmund', shortName: 'Dortmund' },
    };
    now += 60_000;
    await watcher.checkOnce();
    expect(countdownMessage.edit).toHaveBeenCalledTimes(2);
    expect(countdownChannel.send).not.toHaveBeenCalled();
  });

  test('refreshes the live countdown every minute without polling the league again', async () => {
    let now = Date.parse('2026-11-10T12:00:00Z');
    const http = { get: jest.fn(async url => {
      if (url.endsWith('/getavailableleagues')) return { data: [{
        leagueId: 4937,
        leagueShortcut: 'bl1',
        leagueSeason: '2026',
        leagueName: '1. Bundesliga',
        sport: { sportId: 1 },
      }] };
      if (url.endsWith('/getcurrentgroup/bl1')) return { data: { groupName: '10. Spieltag', groupOrderID: 10 } };
      if (url.includes('/getlastchangedate/')) return { data: '2026-11-10T11:00:00Z' };
      if (url.includes('/getmatchdata/')) return { data: [] };
      if (url.includes('/getbltable/')) return { data: [{ teamId: 40, teamName: 'Bayern', shortName: 'Bayern' }] };
      if (url.endsWith('/getnextmatchbyleagueteam/4937/40')) return { data: {
        matchDateTimeUTC: '2026-11-20T19:30:00Z',
        group: { groupName: '10. Spieltag' },
        team1: { teamId: 40, teamName: 'Bayern', shortName: 'Bayern' },
        team2: { teamId: 65, teamName: 'Köln', shortName: 'Köln' },
      } };
      throw new Error(`Unexpected URL: ${url}`);
    }) };
    const countdownMessage = { edit: jest.fn(async () => countdownMessage) };
    const channel = {
      isTextBased: () => true,
      messages: { fetch: jest.fn(async () => []) },
      send: jest.fn(async () => countdownMessage),
    };
    const watcher = createOpenLigaDbWatcher({
      http,
      client: { user: { id: 'bot' }, channels: { cache: new Map([['countdown-channel', channel]]) } },
      ServerProfile: { findAll: async () => [{ guildId: 'guild', settingsJson: JSON.stringify({
        DISCORD_OPENLIGADB_ENABLED: true,
        DISCORD_OPENLIGADB_FEEDS: JSON.stringify([{
          leagueShortcut: 'bl1',
          season: 2026,
          updateIntervalMinutes: 5,
          favoriteTeamIds: [40],
          countdownTeamId: 40,
          countdownStyle: 'graphic_timer',
          countdownColor: '#123456',
          countdownChannelId: 'countdown-channel',
        }]),
      }) }] },
      logger: { warn: jest.fn(), info: jest.fn() },
      requestIntervalMs: 0,
      nowProvider: () => now,
    });

    await watcher.checkOnce();
    const initialPayload = channel.send.mock.calls[0][0];
    now += 60_000;
    await watcher.checkOnce();
    const updatedPayload = countdownMessage.edit.mock.calls[0][0];

    expect(initialPayload.embeds[0].toJSON().color).toBe(0x123456);
    expect(initialPayload.files[0].attachment.equals(updatedPayload.files[0].attachment)).toBe(false);
    expect(initialPayload.embeds[0].toJSON().image.url).not.toBe(updatedPayload.embeds[0].toJSON().image.url);
    expect(updatedPayload.attachments).toEqual([]);
    expect(http.get.mock.calls.filter(([url]) => url.endsWith('/getnextmatchbyleagueteam/4937/40'))).toHaveLength(1);
  });

  test('announces kickoff and halftime once for favorite matches', async () => {
    let now = Date.parse('2026-11-13T17:00:00Z');
    let changedAt = '2026-11-13T16:30:00Z';
    let matches = [{
      matchID: 45,
      matchIsFinished: false,
      matchDateTimeUTC: '2026-11-13T17:01:00Z',
      team1: { teamId: 40, teamName: 'FC Bayern', shortName: 'Bayern' },
      team2: { teamId: 7, teamName: 'Borussia Dortmund', shortName: 'Dortmund' },
      matchResults: [],
      goals: [],
    }];
    const http = { get: jest.fn(async url => {
      if (url.endsWith('/getavailableleagues')) return { data: [{
        leagueId: 4937,
        leagueShortcut: 'bl1',
        leagueSeason: '2026',
        leagueName: '1. Bundesliga',
        sport: { sportId: 1 },
      }] };
      if (url.endsWith('/getcurrentgroup/bl1')) return { data: { groupName: '11. Spieltag', groupOrderID: 11 } };
      if (url.includes('/getlastchangedate/')) return { data: changedAt };
      if (url.includes('/getmatchdata/')) return { data: matches };
      if (url.includes('/getbltable/')) return { data: [] };
      throw new Error(`Unexpected URL: ${url}`);
    }) };
    const scoreboardMessage = { edit: jest.fn(async () => scoreboardMessage) };
    const channel = {
      isTextBased: () => true,
      messages: { fetch: jest.fn(async () => []) },
      send: jest.fn(async payload => typeof payload === 'string' ? payload : scoreboardMessage),
    };
    const watcher = createOpenLigaDbWatcher({
      http,
      client: { user: { id: 'bot' }, channels: { cache: new Map([['channel', channel]]) } },
      ServerProfile: { findAll: async () => [{ guildId: 'guild', settingsJson: JSON.stringify({
        DISCORD_OPENLIGADB_ENABLED: true,
        DISCORD_OPENLIGADB_FEEDS: JSON.stringify([{
          leagueShortcut: 'bl1',
          season: 2026,
          updateIntervalMinutes: 1,
          favoriteTeamIds: [40],
          notificationChannelId: 'channel',
          tableChannelIds: [],
        }]),
      }) }] },
      logger: { warn: jest.fn(), info: jest.fn() },
      requestIntervalMs: 0,
      nowProvider: () => now,
    });

    await watcher.checkOnce();
    now += 60_000;
    await watcher.checkOnce();
    changedAt = '2026-11-13T17:46:00Z';
    matches = [{
      ...matches[0],
      matchResults: [{ resultTypeKind: 'HalfTime', pointsTeam1: 1, pointsTeam2: 0, resultOrderID: 1 }],
      goals: [{ goalID: 900, matchMinute: 31, scoreTeam1: 1, scoreTeam2: 0, goalGetterName: 'Spieler' }],
    }];
    now += 45 * 60_000;
    await watcher.checkOnce();
    now += 60_000;
    await watcher.checkOnce();

    const sentMessages = channel.send.mock.calls.map(([payload]) => payload);
    const eventMessages = sentMessages.filter(payload => typeof payload === 'string');
    expect(eventMessages.filter(message => message.includes('Anpfiff!'))).toHaveLength(1);
    expect(eventMessages.filter(message => message.includes('Halbzeit:'))).toHaveLength(1);
    expect(sentMessages.filter(payload => payload?.content?.includes('Torereignis'))).toHaveLength(1);
  });

  test('announces each newly observed favorite goal only once', async () => {
    let changedAt = '2026-11-07T14:00:00Z';
    let channelId = 'channel';
    let matches = [{
      matchID: 1,
      matchIsFinished: false,
      matchDateTimeUTC: '2026-11-07T14:30:00Z',
      team1: { teamId: 40, teamName: 'FC Bayern München', shortName: 'Bayern' },
      team2: { teamId: 7, teamName: 'Borussia Dortmund', shortName: 'Dortmund' },
      matchResults: [],
      goals: [],
    }];
    const http = { get: jest.fn(async url => {
      if (url.endsWith('/getavailableleagues')) return { data: [{ leagueShortcut: 'bl1', leagueSeason: '2026', leagueName: '1. Bundesliga', sport: { sportId: 1 } }] };
      if (url.endsWith('/getcurrentgroup/bl1')) return { data: { groupName: '9. Spieltag', groupOrderID: 9 } };
      if (url.includes('/getlastchangedate/')) return { data: changedAt };
      if (url.includes('/getmatchdata/')) return { data: matches };
      if (url.includes('/getbltable/')) return { data: [
        { teamId: 40, teamName: 'FC Bayern München', shortName: 'Bayern' },
        { teamId: 7, teamName: 'Borussia Dortmund', shortName: 'Dortmund' },
      ] };
      throw new Error(`Unexpected URL: ${url}`);
    }) };
    const boardMessage = { edit: jest.fn(async () => boardMessage) };
    const channel = {
      isTextBased: () => true,
      messages: { fetch: jest.fn(async () => []) },
      send: jest.fn(async content => typeof content === 'string' ? content : boardMessage),
    };
    const newChannel = {
      isTextBased: () => true,
      messages: { fetch: jest.fn(async () => []) },
      send: jest.fn(async content => content),
    };
    let now = Date.now();
    const watcher = createOpenLigaDbWatcher({
      http,
      client: { user: { id: 'bot' }, channels: { cache: new Map([['channel', channel], ['channel-2', newChannel]]) } },
      ServerProfile: { findAll: async () => [{ guildId: 'guild', settingsJson: JSON.stringify({
        DISCORD_OPENLIGADB_ENABLED: true,
        DISCORD_OPENLIGADB_FEEDS: JSON.stringify([{
          leagueShortcut: 'bl1',
          season: 2025,
          favoriteTeamIds: [40],
          notificationChannelId: channelId,
          tableChannelIds: [],
          finishedMatchImage: {
            enabled: true,
            showScorers: true,
            showCompetition: true,
            showDate: true,
            template: 'minimal',
          },
        }]),
      }) }] },
      logger: { warn: jest.fn(), info: jest.fn() },
      requestIntervalMs: 0,
      nowProvider: () => now,
    });

    await watcher.checkOnce();
    changedAt = '2026-11-07T14:31:00Z';
    matches = [{ ...matches[0], goals: [{ goalID: 123, matchMinute: 31, scoreTeam1: 1, scoreTeam2: 0, goalGetterName: 'Spieler' }] }];
    now += 60_000;
    await watcher.checkOnce();
    now += 60_000;
    await watcher.checkOnce();

    const goalEventPayload = channel.send.mock.calls
      .map(([content]) => content)
      .find(content => content && typeof content === 'object' && content.content?.includes('Torereignis'));
    expect(goalEventPayload.content).toContain('Torereignis');
    expect(goalEventPayload.files[0].name).toBe('openligadb-torereignis.png');
    expect(Buffer.isBuffer(goalEventPayload.files[0].attachment)).toBe(true);
    expect(boardMessage.edit).toHaveBeenCalledTimes(1);

    changedAt = '2026-11-07T16:30:00Z';
    matches = [{
      ...matches[0],
      matchIsFinished: true,
      matchResults: [{ resultTypeKind: 'After90Minutes', pointsTeam1: 1, pointsTeam2: 0 }],
    }];
    now += 60_000;
    await watcher.checkOnce();
    const finishedImagePayload = channel.send.mock.calls
      .map(([content]) => content)
      .find(content => content && typeof content === 'object' && content.content?.includes('Endergebnis'));
    expect(finishedImagePayload.content).toContain('Endergebnis');
    expect(finishedImagePayload.files[0].name).toBe('openligadb-endergebnis.png');
    expect(Buffer.isBuffer(finishedImagePayload.files[0].attachment)).toBe(true);

    channelId = 'channel-2';
    now += 60_000;
    await watcher.checkOnce();
    expect(newChannel.send).toHaveBeenCalledTimes(1);
    expect(typeof newChannel.send.mock.calls[0][0]).toBe('object');
    expect(http.get.mock.calls.some(([url]) => url.includes('/getmatchdata/bl1/2026/9'))).toBe(true);
    expect(http.get.mock.calls.some(([url]) => url.includes('/getmatchdata/bl1/2025/9'))).toBe(false);
  }, 20_000);
});