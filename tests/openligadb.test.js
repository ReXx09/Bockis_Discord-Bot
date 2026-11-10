const {
  buildScoreboardPayload,
  buildLiveTablePayload,
  createOpenLigaDbWatcher,
  fetchLatestLeagueTeams,
  getAvailableFootballLeagues,
  getFavoriteTeamIds,
  getOpenLigaDbUpdateIntervalMs,
  getMatchScore,
  getMatchStatus,
  getSeasonForLeague,
} = require('../services/openligadb');

describe('OpenLigaDB data formatting', () => {
  test('resolves latest season for the selected league', () => {
    const leagues = [
      { leagueShortcut: 'bl1', leagueSeason: '2024' },
      { leagueShortcut: 'bl1', leagueSeason: '2026' },
      { leagueShortcut: 'bl2', leagueSeason: '2027' },
    ];
    expect(getSeasonForLeague(leagues, 'bl1')).toBe(2026);
  });

  test('lists only current-season football leagues', () => {
    const leagues = getAvailableFootballLeagues([
      { leagueShortcut: '1. Fußball-Bundesliga 2007/2008', leagueSeason: '2007', leagueName: '1. Fußball-Bundesliga', sport: { sportId: 1 } },
      { leagueShortcut: 'bl1', leagueSeason: '2025', leagueName: 'Bundesliga', sport: { sportId: 1 } },
      { leagueShortcut: 'bl1', leagueSeason: '2026', leagueName: 'Bundesliga', sport: { sportId: 1 } },
      { leagueShortcut: 'bl2', leagueSeason: '2026', leagueName: '2. Fußball-Bundesliga 2026/2027', sport: { sportId: 1 } },
      { leagueShortcut: 'ucl', leagueSeason: '2026', leagueName: 'Champions League 2026/2027', sport: { sportId: 1 } },
      { leagueShortcut: 'dfb', leagueSeason: '2026', leagueName: 'DFB Pokal 2026/2027', sport: { sportId: 1 } },
      { leagueShortcut: 'cup', leagueSeason: '2026', leagueName: 'Pokal', sport: { sportId: 2 } },
    ], new Date('2026-11-09T12:00:00Z'));

    expect(leagues.map(league => league.leagueShortcut).sort()).toEqual(['bl1', 'bl2', 'dfb', 'ucl']);
    expect(leagues.find(league => league.leagueShortcut === 'bl2').leagueSeason).toBe(2026);
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
      { leagueShortcut: 'wm30', leagueSeason: '2030', leagueName: 'WM 2030', sport: { sportId: 1 } },
      { leagueShortcut: 'DFBNAT2526', leagueSeason: '2025', leagueName: 'Deutsche Fußballnationalmannschaft-Spiele 25/26', sport: { sportId: 1 } },
      { leagueShortcut: 'DFBN', leagueSeason: '2026', leagueName: 'DFB Nationalspiele', sport: { sportId: 1 } },
      { leagueShortcut: 'fna', leagueSeason: '2026', leagueName: 'Frauen-Nationalmannschaft', sport: { sportId: 1 } },
      { leagueShortcut: 'u21dfb', leagueSeason: '2026', leagueName: 'DFB U21', sport: { sportId: 1 } },
    ], new Date('2026-11-09T12:00:00Z'));
    const shortcuts = leagues.map(league => league.leagueShortcut);

    expect(shortcuts).toEqual(expect.arrayContaining(['em2024', 'em2028', 'wm26', 'wm30', 'DFBN', 'fna', 'u21dfb']));
    for (const excludedShortcut of ['em', 'em2020', 'em2024mitKarten', 'wm2022', 'wm2026', 'DFBNAT2526']) {
      expect(shortcuts).not.toContain(excludedShortcut);
    }
  });

  test('includes current Europa League, Conference League, and Nations League entries', () => {
    const leagues = getAvailableFootballLeagues([
      { leagueShortcut: 'uel2024', leagueSeason: '2024', leagueName: 'Europa League 2024/25', sport: { sportId: 1 } },
      { leagueShortcut: 'uel2026', leagueSeason: '2026', leagueName: 'Europa League 2026/27', sport: { sportId: 1 } },
      { leagueShortcut: 'uel-test', leagueSeason: '2026', leagueName: 'Europa League unused', sport: { sportId: 1 } },
      { leagueShortcut: 'uecl2023', leagueSeason: '2023', leagueName: 'UEFA Europa Conference League 2023', sport: { sportId: 1 } },
      { leagueShortcut: 'uecl2026', leagueSeason: '2026', leagueName: 'Conference League 2026/27', sport: { sportId: 1 } },
      { leagueShortcut: 'unl2024', leagueSeason: '2024', leagueName: 'Nations League 2024/25 (DE)', sport: { sportId: 1 } },
      { leagueShortcut: 'unl', leagueSeason: '2026', leagueName: 'Nations League 2026/27', sport: { sportId: 1 } },
      { leagueShortcut: 'nla', leagueSeason: '2026', leagueName: 'Nations League A 2026', sport: { sportId: 1 } },
    ], new Date('2026-11-09T12:00:00Z'));
    const shortcuts = leagues.map(league => league.leagueShortcut);

    expect(shortcuts).toEqual(expect.arrayContaining(['uel2026', 'uecl2026', 'unl']));
    for (const excludedShortcut of ['uel2024', 'uel-test', 'uecl2023', 'unl2024', 'nla']) {
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

    expect(channel.send.mock.calls.filter(([content]) => typeof content === 'string')).toHaveLength(1);
    expect(channel.send.mock.calls.find(([content]) => typeof content === 'string')[0]).toContain('Tor');
    expect(boardMessage.edit).toHaveBeenCalledTimes(1);

    channelId = 'channel-2';
    now += 60_000;
    await watcher.checkOnce();
    expect(newChannel.send).toHaveBeenCalledTimes(1);
    expect(typeof newChannel.send.mock.calls[0][0]).toBe('object');
    expect(http.get.mock.calls.some(([url]) => url.includes('/getmatchdata/bl1/2026/9'))).toBe(true);
    expect(http.get.mock.calls.some(([url]) => url.includes('/getmatchdata/bl1/2025/9'))).toBe(false);
  }, 20_000);
});