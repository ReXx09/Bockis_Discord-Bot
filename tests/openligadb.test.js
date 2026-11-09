const {
  buildScoreboardPayload,
  buildLiveTablePayload,
  createOpenLigaDbWatcher,
  fetchLatestLeagueTeams,
  getAvailableFootballLeagues,
  getFavoriteTeamIds,
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

  test('limits favorite teams to the configured maximum', () => {
    expect(getFavoriteTeamIds({ favoriteTeamIds: [40, 7, 40], maxFavorites: 1 })).toEqual([40]);
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
    });

    await watcher.checkOnce();
    changedAt = '2026-11-07T14:31:00Z';
    matches = [{ ...matches[0], goals: [{ goalID: 123, matchMinute: 31, scoreTeam1: 1, scoreTeam2: 0, goalGetterName: 'Spieler' }] }];
    await watcher.checkOnce();
    await watcher.checkOnce();

    expect(channel.send.mock.calls.filter(([content]) => typeof content === 'string')).toHaveLength(1);
    expect(channel.send.mock.calls.find(([content]) => typeof content === 'string')[0]).toContain('Tor');
    expect(boardMessage.edit).toHaveBeenCalledTimes(1);

    channelId = 'channel-2';
    await watcher.checkOnce();
    expect(newChannel.send).toHaveBeenCalledTimes(1);
    expect(typeof newChannel.send.mock.calls[0][0]).toBe('object');
    expect(http.get.mock.calls.some(([url]) => url.includes('/getmatchdata/bl1/2026/9'))).toBe(true);
    expect(http.get.mock.calls.some(([url]) => url.includes('/getmatchdata/bl1/2025/9'))).toBe(false);
  }, 20_000);
});