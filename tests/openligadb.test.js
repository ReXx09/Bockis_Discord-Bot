const {
  buildScoreboardPayload,
  createOpenLigaDbWatcher,
  fetchLatestLeagueTeams,
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

  test('loads the latest league season and normalizes its teams', async () => {
    const http = { get: jest.fn(async url => {
      if (url.endsWith('/getavailableleagues')) {
        return { data: [{ leagueShortcut: 'bl1', leagueSeason: '2025' }, { leagueShortcut: 'bl1', leagueSeason: '2026' }] };
      }
      return { data: [
        { teamId: 7, teamName: 'Borussia Dortmund', shortName: 'Dortmund' },
        { teamId: 40, teamName: 'FC Bayern München', shortName: 'Bayern' },
      ] };
    }) };

    const league = await fetchLatestLeagueTeams(http);

    expect(league.season).toBe(2026);
    expect(league.teams.map(team => team.teamId)).toEqual([7, 40]);
    expect(http.get.mock.calls[1][0]).toContain('/getavailableteams/bl1/2026');
  });

  test('announces each newly observed favorite goal only once', async () => {
    let changedAt = '2026-11-07T14:00:00Z';
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
      if (url.endsWith('/getavailableleagues')) return { data: [{ leagueShortcut: 'bl1', leagueSeason: '2026' }] };
      if (url.endsWith('/getcurrentgroup/bl1')) return { data: { groupName: '9. Spieltag', groupOrderID: 9 } };
      if (url.includes('/getlastchangedate/')) return { data: changedAt };
      if (url.includes('/getmatchdata/')) return { data: matches };
      throw new Error(`Unexpected URL: ${url}`);
    }) };
    const boardMessage = { edit: jest.fn(async () => boardMessage) };
    const channel = {
      isTextBased: () => true,
      messages: { fetch: jest.fn(async () => []) },
      send: jest.fn(async content => typeof content === 'string' ? content : boardMessage),
    };
    const watcher = createOpenLigaDbWatcher({
      http,
      client: { user: { id: 'bot' }, channels: { cache: new Map([['channel', channel]]) } },
      ServerProfile: { findAll: async () => [{ guildId: 'guild', settingsJson: JSON.stringify({
        DISCORD_OPENLIGADB_ENABLED: true,
        DISCORD_OPENLIGADB_CHANNEL_ID: 'channel',
        DISCORD_OPENLIGADB_FAVORITES: '40',
      }) }] },
      logger: { warn: jest.fn(), info: jest.fn() },
    });

    await watcher.checkOnce();
    changedAt = '2026-11-07T14:31:00Z';
    matches = [{ ...matches[0], goals: [{ goalID: 123, matchMinute: 31, scoreTeam1: 1, scoreTeam2: 0, goalGetterName: 'Spieler' }] }];
    await watcher.checkOnce();
    await watcher.checkOnce();

    expect(channel.send.mock.calls.filter(([content]) => typeof content === 'string')).toHaveLength(1);
    expect(channel.send.mock.calls.find(([content]) => typeof content === 'string')[0]).toContain('Tor');
    expect(boardMessage.edit).toHaveBeenCalledTimes(1);
  });
});