'use strict';

const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { recordApiRequest } = require('./api-usage');
const {
  buildFinishedMatchPng,
  buildNextMatchCountdownMessage,
  getFavoriteTeamIds,
  OPENLIGADB_COUNTDOWN_STYLES,
} = require('./openligadb');

const API_BASE = 'https://v3.football.api-sports.io';
const REQUEST_TIMEOUT_MS = 10_000;
const CHECK_INTERVAL_MS = 60_000;
const LIVE_POLL_INTERVAL_MS = 20 * 60_000;
const API_POLL_LEAD_TIME_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_REFRESH_INTERVAL_MINUTES = 1440;
const MIN_REFRESH_INTERVAL_MINUTES = 60;
const MAX_REFRESH_INTERVAL_MINUTES = 1440;
const LIVE_MATCH_WINDOW_MS = 3 * 60 * 60_000;
const MAX_DISCORD_EMBED_CHARACTERS = 6000;
const API_FOOTBALL_COMPETITIONS = Object.freeze([
  { leagueId: 4, name: 'UEFA Europameisterschaft', category: 'Europameisterschaft', defaultSeason: 2028 },
  { leagueId: 960, name: 'UEFA Europameisterschaft Qualifikation', category: 'Qualifikation', defaultSeason: 2027 },
  { leagueId: 1, name: 'FIFA Weltmeisterschaft', category: 'Weltmeisterschaft', defaultSeason: 2030 },
  { leagueId: 32, name: 'WM-Qualifikation Europa', category: 'Qualifikation', defaultSeason: 2026 },
  { leagueId: 29, name: 'WM-Qualifikation Afrika', category: 'Qualifikation', defaultSeason: 2026 },
  { leagueId: 30, name: 'WM-Qualifikation Asien', category: 'Qualifikation', defaultSeason: 2026 },
  { leagueId: 31, name: 'WM-Qualifikation Nord-/Mittelamerika', category: 'Qualifikation', defaultSeason: 2026 },
  { leagueId: 33, name: 'WM-Qualifikation Südamerika', category: 'Qualifikation', defaultSeason: 2026 },
  { leagueId: 34, name: 'WM-Qualifikation Ozeanien', category: 'Qualifikation', defaultSeason: 2026 },
]);
const SUPPORTED_LEAGUE_IDS = new Set(API_FOOTBALL_COMPETITIONS.map(item => item.leagueId));

function normalizeApiFootballFeeds(value) {
  let feeds;
  try { feeds = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new Error('API-Football-Feeds müssen gültiges JSON sein.'); }
  if (!Array.isArray(feeds) || feeds.length > 12) throw new Error('Es sind höchstens 12 API-Football-Turnierfeeds erlaubt.');
  const seen = new Set();
  return feeds.map(feed => {
    if (!feed || typeof feed !== 'object' || Array.isArray(feed)) throw new Error('Ungültiger API-Football-Feed.');
    const leagueId = Number(feed.leagueId);
    const season = Number(feed.season);
    const liveChannelId = String(feed.liveChannelId || feed.channelId || '').trim();
    const tableChannelId = String(feed.tableChannelId || '').trim();
    const notificationChannelId = String(feed.notificationChannelId || '').trim();
    const countdownChannelId = String(feed.countdownChannelId || '').trim();
    const competition = API_FOOTBALL_COMPETITIONS.find(item => item.leagueId === leagueId);
    if (!competition || !Number.isInteger(season) || season < 2000 || season > 2200
      || (liveChannelId && !/^\d{5,24}$/.test(liveChannelId))
      || (tableChannelId && !/^\d{5,24}$/.test(tableChannelId))
      || (notificationChannelId && !/^\d{5,24}$/.test(notificationChannelId))
      || (countdownChannelId && !/^\d{5,24}$/.test(countdownChannelId))
      || (!liveChannelId && !tableChannelId && !notificationChannelId && !countdownChannelId)) {
      throw new Error('Jeder Feed braucht einen unterstützten Wettbewerb, eine Saison und mindestens einen gültigen Discord-Kanal.');
    }
    const key = `${leagueId}:${season}`;
    if (seen.has(key)) throw new Error(`${competition.name} · ${season} ist doppelt eingetragen.`);
    seen.add(key);
    const startDate = String(feed.startDate || '').trim();
    const parsedStartDate = /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? new Date(`${startDate}T00:00:00Z`) : null;
    if (startDate && (!parsedStartDate || Number.isNaN(parsedStartDate.getTime()) || parsedStartDate.toISOString().slice(0, 10) !== startDate)) {
      throw new Error(`Ungültiges Startdatum für ${competition.name}.`);
    }
    const interval = feed.updateIntervalMinutes == null || feed.updateIntervalMinutes === ''
      ? DEFAULT_REFRESH_INTERVAL_MINUTES
      : Number(feed.updateIntervalMinutes);
    if (!Number.isInteger(interval) || interval < MIN_REFRESH_INTERVAL_MINUTES || interval > MAX_REFRESH_INTERVAL_MINUTES) {
      throw new Error(`Das Abrufintervall für ${competition.name} muss zwischen ${MIN_REFRESH_INTERVAL_MINUTES} und ${MAX_REFRESH_INTERVAL_MINUTES} Minuten liegen.`);
    }
    const rawFavoriteTeamIds = feed.favoriteTeamIds == null ? [] : feed.favoriteTeamIds;
    if (!Array.isArray(rawFavoriteTeamIds) || rawFavoriteTeamIds.length > 40
      || rawFavoriteTeamIds.some(id => !Number.isInteger(Number(id)) || Number(id) <= 0)) {
      throw new Error(`Ungültige Favoriten für ${competition.name}.`);
    }
    const favoriteTeamIds = [...new Set(rawFavoriteTeamIds.map(Number))];
    const maxFavorites = feed.maxFavorites == null || feed.maxFavorites === ''
      ? Math.min(40, Math.max(5, favoriteTeamIds.length))
      : Number(feed.maxFavorites);
    if (!Number.isInteger(maxFavorites) || maxFavorites < 1 || maxFavorites > 40) {
      throw new Error(`Die maximale Favoritenanzahl für ${competition.name} muss zwischen 1 und 40 liegen.`);
    }
    if (favoriteTeamIds.length > maxFavorites) {
      throw new Error(`Für ${competition.name} sind höchstens ${maxFavorites} Favoriten erlaubt.`);
    }
    const countdownTeamId = feed.countdownTeamId == null || feed.countdownTeamId === '' ? null : Number(feed.countdownTeamId);
    if (countdownTeamId !== null && (!Number.isInteger(countdownTeamId) || !favoriteTeamIds.includes(countdownTeamId))) {
      throw new Error(`Das Countdown-Team für ${competition.name} muss als Favorit ausgewählt sein.`);
    }
    const countdownStyle = String(feed.countdownStyle || 'classic');
    if (!OPENLIGADB_COUNTDOWN_STYLES.includes(countdownStyle)) {
      throw new Error(`Ungültige Countdown-Vorlage für ${competition.name}.`);
    }
    const countdownColor = String(feed.countdownColor || '#1C8C73').trim();
    if (!/^#[\da-f]{6}$/i.test(countdownColor)) {
      throw new Error(`Ungültige Countdown-Farbe für ${competition.name}.`);
    }
    const imageSettings = feed.finishedMatchImage == null ? {} : feed.finishedMatchImage;
    if (typeof imageSettings !== 'object' || Array.isArray(imageSettings)) {
      throw new Error(`Ungültige Ergebnisgrafik-Einstellungen für ${competition.name}.`);
    }
    const normalizeImageFlag = (key, defaultValue) => {
      const flag = imageSettings[key];
      if (flag == null) return defaultValue;
      if (typeof flag !== 'boolean') throw new Error(`Ungültige Ergebnisgrafik-Einstellung "${key}" für ${competition.name}.`);
      return flag;
    };
    const imageTemplate = String(imageSettings.template || 'stadium');
    if (!['stadium', 'classic', 'minimal'].includes(imageTemplate)) {
      throw new Error(`Ungültige Ergebnisgrafik-Vorlage für ${competition.name}.`);
    }
    return {
      leagueId,
      season,
      name: competition.name,
      liveChannelId,
      tableChannelId,
      notificationChannelId,
      countdownChannelId,
      startDate,
      updateIntervalMinutes: interval,
      favoriteTeamIds,
      maxFavorites,
      countdownTeamId,
      countdownStyle,
      countdownColor,
      finishedMatchImage: {
        enabled: normalizeImageFlag('enabled', false),
        showScorers: normalizeImageFlag('showScorers', true),
        showCompetition: normalizeImageFlag('showCompetition', true),
        showDate: normalizeImageFlag('showDate', false),
        template: imageTemplate,
      },
    };
  });
}

function parseApiFootballFeeds(settings) {
  try {
    const feeds = typeof settings === 'string' ? JSON.parse(settings) : settings;
    return Array.isArray(feeds) ? feeds.filter(feed => feed
      && Number.isInteger(Number(feed.leagueId))
      && Number.isInteger(Number(feed.season))
      && (/^\d{5,24}$/.test(String(feed.liveChannelId || feed.channelId || ''))
        || /^\d{5,24}$/.test(String(feed.tableChannelId || ''))
        || /^\d{5,24}$/.test(String(feed.notificationChannelId || ''))
        || /^\d{5,24}$/.test(String(feed.countdownChannelId || '')))) : [];
  } catch {
    return [];
  }
}

function getApiFootballRefreshIntervalMs(feed) {
  const minutes = Number(feed.updateIntervalMinutes);
  const safeMinutes = Number.isInteger(minutes) && minutes >= MIN_REFRESH_INTERVAL_MINUTES && minutes <= MAX_REFRESH_INTERVAL_MINUTES
    ? minutes
    : DEFAULT_REFRESH_INTERVAL_MINUTES;
  return safeMinutes * 60_000;
}

function shouldPollApiFootballFixtures(feed, now = Date.now()) {
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(feed.startDate || ''))
    ? Date.parse(`${feed.startDate}T00:00:00Z`)
    : NaN;
  return !Number.isFinite(startDate) || startDate <= now + API_POLL_LEAD_TIME_MS;
}

async function fetchApiFootballFixtures(http, apiKey, { leagueId, season }, usageTracker = { recordApiRequest }) {
  if (!String(apiKey || '').trim()) throw new Error('API-Football-Schlüssel fehlt.');
  if (!Number.isInteger(Number(leagueId)) || Number(leagueId) <= 0 || !Number.isInteger(Number(season))) {
    throw new Error('Ungültige API-Football-Liga oder Saison.');
  }
  if (!usageTracker.recordApiRequest('apiFootball')) {
    const error = new Error('Konfiguriertes API-Football-Tageslimit erreicht.');
    error.code = 'API_DAILY_LIMIT';
    throw error;
  }
  const response = await http.get(`${API_BASE}/fixtures`, {
    params: { league: Number(leagueId), season: Number(season) },
    headers: { 'x-apisports-key': String(apiKey).trim() },
    timeout: REQUEST_TIMEOUT_MS,
  });
  const errors = response.data?.errors;
  if (errors && (Array.isArray(errors) ? errors.length : Object.keys(errors).length)) {
    throw new Error('API-Football hat die Fixture-Abfrage abgelehnt.');
  }
  return Array.isArray(response.data?.response) ? response.data.response : [];
}

async function fetchApiFootballStandings(http, apiKey, { leagueId, season }, usageTracker = { recordApiRequest }) {
  const response = await requestApiFootball(http, apiKey, '/standings', { league: Number(leagueId), season: Number(season) }, usageTracker);
  return Array.isArray(response) ? response : [];
}

async function fetchApiFootballTeams(http, apiKey, { leagueId, season }, usageTracker = { recordApiRequest }) {
  const response = await requestApiFootball(http, apiKey, '/teams', {
    league: Number(leagueId),
    season: Number(season),
  }, usageTracker);
  return response.map(item => item?.team)
    .filter(team => Number.isInteger(Number(team?.id)) && Number(team.id) > 0 && team.name)
    .map(team => ({ teamId: Number(team.id), teamName: String(team.name), shortName: String(team.code || team.name) }))
    .sort((a, b) => a.teamName.localeCompare(b.teamName, 'de'));
}

function toOpenLigaDbCountdownMatch(fixture) {
  const date = fixture?.fixture?.date;
  if (!date) return null;
  return {
    matchDateTimeUTC: date,
    group: { groupName: fixture.league?.round || '' },
    team1: {
      teamId: Number(fixture.teams?.home?.id),
      teamName: fixture.teams?.home?.name || 'Heimteam',
      shortName: fixture.teams?.home?.name || 'Heimteam',
    },
    team2: {
      teamId: Number(fixture.teams?.away?.id),
      teamName: fixture.teams?.away?.name || 'Auswärtsteam',
      shortName: fixture.teams?.away?.name || 'Auswärtsteam',
    },
  };
}

async function buildApiFootballFinishedMatchGraphic(http, apiKey, feed, fixture, usageTracker = { recordApiRequest }) {
  const match = {
    ...toOpenLigaDbCountdownMatch(fixture),
    matchIsFinished: true,
    goals: [],
    matchResults: [{
      resultTypeKind: 'After90Minutes',
      pointsTeam1: Number(fixture.goals?.home) || 0,
      pointsTeam2: Number(fixture.goals?.away) || 0,
    }],
  };

  if (feed.finishedMatchImage?.showScorers && fixture.fixture?.id) {
    try {
      const events = await requestApiFootball(http, apiKey, '/fixtures/events', { fixture: fixture.fixture.id }, usageTracker);
      match.goals = events.filter(event => event.type === 'Goal' && event.team?.id)
        .map(event => ({
          goalGetterName: event.player?.name || 'Unbekannt',
          matchMinute: Number(event.time?.elapsed) || 0,
        }));
    } catch (error) {
      if (error.code !== 'API_DAILY_LIMIT') throw error;
    }
  }

  return buildFinishedMatchPng({
    leagueName: feed.name || fixture.league?.name || 'API-Football',
    group: { groupName: fixture.league?.round || '' },
    match,
    settings: feed.finishedMatchImage,
    sourceLabel: 'API-Football',
  });
}

async function fetchApiFootballSeasonStartDate(http, apiKey, { leagueId, season }, usageTracker = { recordApiRequest }) {
  const numericLeagueId = Number(leagueId);
  const numericSeason = Number(season);
  if (!SUPPORTED_LEAGUE_IDS.has(numericLeagueId) || !Number.isInteger(numericSeason)) {
    throw new Error('Ungültiger API-Football-Wettbewerb oder Saison.');
  }
  const response = await requestApiFootball(http, apiKey, '/leagues', {
    id: numericLeagueId,
    season: numericSeason,
  }, usageTracker);
  const competition = response.find(item => Number(item.league?.id) === numericLeagueId);
  const seasonData = competition?.seasons?.find(item => Number(item.year) === numericSeason);
  const startDate = String(seasonData?.start || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(startDate)
    && !Number.isNaN(Date.parse(`${startDate}T00:00:00Z`))
    ? startDate
    : null;
}

async function fetchApiFootballLiveFixtures(http, apiKey, usageTracker = { recordApiRequest }) {
  return requestApiFootball(http, apiKey, '/fixtures', { live: 'all' }, usageTracker);
}

async function requestApiFootball(http, apiKey, endpoint, params, usageTracker) {
  if (!String(apiKey || '').trim()) throw new Error('API-Football-Schlüssel fehlt.');
  if (!usageTracker.recordApiRequest('apiFootball')) {
    const error = new Error('Konfiguriertes API-Football-Tageslimit erreicht.');
    error.code = 'API_DAILY_LIMIT';
    throw error;
  }
  const response = await http.get(`${API_BASE}${endpoint}`, {
    params,
    headers: { 'x-apisports-key': String(apiKey).trim() },
    timeout: REQUEST_TIMEOUT_MS,
  });
  const errors = response.data?.errors;
  if (errors && (Array.isArray(errors) ? errors.length : Object.keys(errors).length)) {
    const error = new Error('API-Football hat die Abfrage abgelehnt.');
    error.providerErrors = errors;
    error.code = /key|token|authori[sz]|subscription|access/i.test(JSON.stringify(errors))
      ? 'API_FOOTBALL_AUTH'
      : 'API_FOOTBALL_REJECTED';
    throw error;
  }
  return Array.isArray(response.data?.response) ? response.data.response : [];
}

function classifyApiFootballProviderError(error) {
  const providerErrors = error.providerErrors || error.response?.data?.errors;
  const message = `${JSON.stringify(providerErrors || '')} ${error.response?.data?.message || ''}`.toLowerCase();
  if (/(?:ip|domain).*(?:not allowed|denied|unauthori[sz]ed)|(?:not allowed|denied|unauthori[sz]ed).*(?:ip|domain)/.test(message)) {
    return 'restriction';
  }
  if (/not subscribed|subscription|subscribe/.test(message)) return 'subscription';
  if (/invalid.{0,20}(?:api[_ -]?)?(?:key|token)|(?:key|token).{0,20}invalid|unauthori[sz]ed|authentication/.test(message)
    || error.response?.status === 401) {
    return 'key';
  }
  if (error.response?.status === 403) return 'access';
  return 'unknown';
}

function buildApiFootballTournamentPayload(feed, fixtures, now = Date.now()) {
  const upcoming = (Array.isArray(fixtures) ? fixtures : [])
    .filter(item => item?.fixture?.date && Date.parse(item.fixture.date) > now
      && !['FT', 'AET', 'PEN', 'CANC', 'ABD', 'AWD', 'WO'].includes(item.fixture.status?.short))
    .sort((a, b) => Date.parse(a.fixture.date) - Date.parse(b.fixture.date));
  const embed = new EmbedBuilder()
    .setColor(0x1C8C73)
    .setTitle(`🏆 ${feed.name || 'Internationales Turnier'}`)
    .setFooter({ text: 'API-Football · Spielplan, Anstoßzeiten und Spielorte' });

  if (!upcoming.length) {
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(feed.startDate || ''))
      ? Date.parse(`${feed.startDate}T00:00:00Z`)
      : NaN;
    embed.setDescription(Number.isFinite(startDate) && startDate > now
      ? `**Turnierbeginn**\n<t:${Math.floor(startDate / 1000)}:D> · <t:${Math.floor(startDate / 1000)}:R>\n\nFür dieses Turnier sind noch keine Spiele verfügbar.`
      : 'Für dieses Turnier sind derzeit keine zukünftigen Spiele verfügbar.');
    return { embeds: [embed] };
  }

  const next = upcoming[0];
  const timestamp = Math.floor(Date.parse(next.fixture.date) / 1000);
  const home = next.teams?.home?.name || 'Heimteam';
  const away = next.teams?.away?.name || 'Auswärtsteam';
  const venue = [next.fixture.venue?.name, next.fixture.venue?.city].filter(Boolean).join(' · ') || 'Austragungsort noch offen';
  const competition = [next.league?.name, next.league?.round].filter(Boolean).join(' · ');
  embed.setDescription(`**Nächstes Spiel**\n${home} gegen ${away}\n\nAnstoß: <t:${timestamp}:F> · <t:${timestamp}:R>\nAustragungsort: ${venue}`);
  if (competition) embed.addFields({ name: 'Wettbewerb', value: competition.slice(0, 1024) });
  if (upcoming.length > 1) {
    const nextMatches = upcoming.slice(1, 6).map(item => {
      const kickoff = Math.floor(Date.parse(item.fixture.date) / 1000);
      const fixtureVenue = [item.fixture.venue?.name, item.fixture.venue?.city].filter(Boolean).join(' · ');
      return `<t:${kickoff}:f> ${item.teams?.home?.name || 'Heim'} – ${item.teams?.away?.name || 'Auswärts'}${fixtureVenue ? ` · ${fixtureVenue}` : ''}`;
    });
    embed.addFields({ name: 'Weitere Spiele', value: nextMatches.join('\n').slice(0, 1024) });
  }
  return { embeds: [embed] };
}

function buildApiFootballLivePayload(feed, fixtures, scheduledFixtures = [], now = Date.now()) {
  const liveStatuses = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT']);
  const liveFixtures = (Array.isArray(fixtures) ? fixtures : []).filter(item =>
    Number(item.league?.id) === Number(feed.leagueId) && liveStatuses.has(item.fixture?.status?.short));
  if (!liveFixtures.length) return buildApiFootballTournamentPayload(feed, scheduledFixtures, now);

  const embed = new EmbedBuilder()
    .setColor(0xE74C3C)
    .setTitle(`🔴 Live · ${feed.name || 'Turnier'}`)
    .setFooter({ text: 'API-Football · Live-Spielstände' });
  const lines = liveFixtures.slice(0, 20).map(item => {
    const home = item.teams?.home?.name || 'Heimteam';
    const away = item.teams?.away?.name || 'Auswärtsteam';
    const homeGoals = item.goals?.home ?? 0;
    const awayGoals = item.goals?.away ?? 0;
    const elapsed = item.fixture?.status?.elapsed;
    const matchTime = elapsed == null ? item.fixture?.status?.short : `${elapsed}'`;
    const group = item.league?.round ? ` · ${item.league.round}` : '';
    return `**${home} ${homeGoals}:${awayGoals} ${away}** · ${matchTime}${group}`;
  });
  embed.setDescription(lines.join('\n').slice(0, 4000));
  return { embeds: [embed] };
}

function buildApiFootballFavoriteMatchPayload(feed, fixture) {
  const favoriteIds = getFavoriteTeamIds(feed);
  const favorite = [fixture.teams?.home, fixture.teams?.away]
    .find(team => favoriteIds.includes(Number(team?.id)));
  const elapsed = fixture.fixture?.status?.elapsed;
  const status = fixture.fixture?.status?.short === 'HT' ? 'Halbzeit' : (elapsed == null ? 'Live' : `${elapsed}. Minute`);
  const embed = new EmbedBuilder()
    .setColor(0xE74C3C)
    .setTitle(`⚽ ${favorite?.name || 'Favorit'} · Live-Spiel`)
    .setDescription(`**${fixture.teams?.home?.name || 'Heimteam'} ${Number(fixture.goals?.home) || 0}:${Number(fixture.goals?.away) || 0} ${fixture.teams?.away?.name || 'Auswärtsteam'}**\n${status} · ${fixture.league?.round || feed.name || 'Wettbewerb'}`)
    .setFooter({ text: 'API-Football · Favoritenspiel' });
  return { embeds: [embed] };
}

function buildApiFootballStandingsPayload(feed, response) {
  const embed = new EmbedBuilder()
    .setColor(0x1C8C73)
    .setTitle(`📊 Tabelle · ${feed.name || 'Turnier'} ${feed.season}`)
    .setFooter({ text: 'API-Football · Tabellenstand' });
  const groups = response?.[0]?.league?.standings;
  if (!Array.isArray(groups) || !groups.length) {
    embed.setDescription('Für diesen Wettbewerb ist derzeit keine Tabelle verfügbar.');
    return { embeds: [embed] };
  }
  for (const [index, group] of groups.entries()) {
    if (!Array.isArray(group) || !group.length) continue;
    const title = group[0]?.group || `Gruppe ${index + 1}`;
    const rows = group.slice(0, 20).map(row => {
      const name = row.team?.name || 'Team';
      const points = row.points ?? '-';
      const played = row.all?.played ?? '-';
      const goalDifference = row.goalsDiff == null ? '' : ` · Diff. ${row.goalsDiff > 0 ? '+' : ''}${row.goalsDiff}`;
      return `**${row.rank}. ${name}** · ${points} Pkt. · ${played} Sp.${goalDifference}`;
    });
    embed.addFields({ name: String(title).slice(0, 256), value: rows.join('\n').slice(0, 1024) || 'Keine Tabellendaten.' });
    if (embed.data.fields.length >= 25) break;
  }
  if (!embed.data.fields?.length) embed.setDescription('Für diesen Wettbewerb ist derzeit keine Tabelle verfügbar.');
  return { embeds: [embed] };
}

function hasApiFootballMatchWindow(fixtures, now = Date.now()) {
  return (Array.isArray(fixtures) ? fixtures : []).some(item => {
    const kickoff = Date.parse(item?.fixture?.date || '');
    if (!Number.isFinite(kickoff)) return false;
    if (['FT', 'AET', 'PEN', 'CANC', 'ABD', 'AWD', 'WO'].includes(item.fixture?.status?.short)) return false;
    return kickoff >= now - LIVE_MATCH_WINDOW_MS && kickoff <= now + LIVE_MATCH_WINDOW_MS;
  });
}

function fitApiFootballEmbed(embed) {
  const data = embed.toJSON();
  const fixedTextLength = (data.title || '').length
    + (data.footer?.text || '').length
    + (data.author?.name || '').length;
  const description = data.description || '';
  const descriptionBudget = Math.min(4096, Math.max(0, MAX_DISCORD_EMBED_CHARACTERS - fixedTextLength));
  const fittedDescription = description.slice(0, descriptionBudget);
  if (fittedDescription !== description) embed.setDescription(fittedDescription || '\u200b');

  let remainingCharacters = MAX_DISCORD_EMBED_CHARACTERS - fixedTextLength - fittedDescription.length;
  const fields = [];
  for (const field of (data.fields || []).slice(0, 25)) {
    const name = String(field.name || '').slice(0, 256);
    const value = String(field.value || '');
    const valueBudget = Math.min(1024, remainingCharacters - name.length);
    if (valueBudget < 1) break;
    const fittedValue = value.slice(0, valueBudget);
    fields.push({ ...field, name, value: fittedValue || '\u200b' });
    remainingCharacters -= name.length + fittedValue.length;
    if (fittedValue.length < value.length) break;
  }
  embed.setFields(fields);
  return embed;
}

function createApiFootballWatcher({ http, client, logger, getApiKey, getFeeds, nowProvider = () => Date.now(), usageTracker = { recordApiRequest } }) {
  let timer = null;
  let inFlight = false;
  let pausedUntilUtcDate = null;
  let lastLivePollAt = 0;
  const fixturesByFeed = new Map();
  const fixturesFetchedAtByFeed = new Map();
  const standingsFetchedAtByFeed = new Map();
  const messages = new Map();
  const signatures = new Map();
  const announcedFinishedMatches = new Set();
  const favoriteGoalScores = new Map();
  let lastFeedConfigSignature = '';

  async function getChannel(channelId) {
    let channel = client.channels.cache.get(String(channelId));
    if (!channel) channel = await client.channels.fetch(String(channelId));
    return channel?.isTextBased?.() && channel.messages && channel.send ? channel : null;
  }

  async function upsertMessage(feedKey, channelId, kind, payload) {
    channelId = String(channelId || '').trim();
    if (!channelId) return;
    const channel = await getChannel(channelId);
    if (!channel) {
      logger.warn(`API-Football-${kind} für Feed ${feedKey} nicht gesendet: Zielkanal ist nicht erreichbar oder kein Textkanal.`);
      return;
    }
    const marker = `API-Football:${kind}:${feedKey}`;
    const embed = payload.embeds[0];
    const footer = embed.toJSON().footer?.text || 'API-Football';
    embed.setFooter({ text: `${footer} · ${marker}` });
    fitApiFootballEmbed(embed);
    const signature = JSON.stringify(embed.toJSON());
    const key = `${kind}:${feedKey}:${channelId}`;
    if (signatures.get(key) === signature && messages.has(key)) return;

    let message = messages.get(key);
    if (!message) {
      const recent = await channel.messages.fetch({ limit: 50 });
      message = recent.find(candidate => candidate.author.id === client.user.id
        && candidate.embeds.some(existing => (existing.footer?.text || '').includes(marker)));
    }
    const messagePayload = { ...payload, embeds: [embed] };
    const wasExisting = Boolean(message);
    if (message) message = await message.edit(messagePayload);
    else message = await channel.send(messagePayload);
    messages.set(key, message);
    signatures.set(key, signature);
    logger.info(`API-Football-${kind} für Feed ${feedKey} in Discord ${wasExisting ? 'aktualisiert' : 'gesendet'}.`);
  }

  async function checkOnce() {
    if (inFlight) return;
    inFlight = true;
    try {
      const apiKey = String(getApiKey() || '').trim();
      const currentUtcDate = new Date(nowProvider()).toISOString().slice(0, 10);
      if (pausedUntilUtcDate === currentUtcDate) return;
      pausedUntilUtcDate = null;
      const feeds = parseApiFootballFeeds(getFeeds());
      const feedConfigSignature = JSON.stringify(feeds);
      if (feedConfigSignature !== lastFeedConfigSignature) {
        const feedsWithDiscordTargets = feeds.filter(feed => feed.liveChannelId || feed.channelId
          || feed.tableChannelId || feed.notificationChannelId || feed.countdownChannelId).length;
        logger.info(`API-Football-Konfiguration geladen: ${feeds.length} Feed(s), ${feedsWithDiscordTargets} mit Discord-Ziel.`);
        lastFeedConfigSignature = feedConfigSignature;
      }
      const activeKeys = new Set(feeds.map(feed => `${feed.leagueId}:${feed.season}`));
      for (const feed of feeds) {
        const feedKey = `${feed.leagueId}:${feed.season}`;
        const now = nowProvider();
        if (!shouldPollApiFootballFixtures(feed, now)) {
          if (feed.liveChannelId || feed.channelId) {
            try {
              await upsertMessage(feedKey, feed.liveChannelId || feed.channelId, 'live', buildApiFootballTournamentPayload(feed, [], now));
            } catch (error) {
              logger.warn(`API-Football-Countdown ${feed.name || feedKey} fehlgeschlagen: ${error.message}`);
            }
          }
        } else if (!apiKey) {
          if (feed.liveChannelId || feed.channelId) {
            try {
              await upsertMessage(feedKey, feed.liveChannelId || feed.channelId, 'live', buildApiFootballTournamentPayload(feed, [], now));
            } catch (error) {
              logger.warn(`API-Football-Countdown ${feed.name || feedKey} fehlgeschlagen: ${error.message}`);
            }
          }
        } else {
          const refreshInterval = getApiFootballRefreshIntervalMs(feed);
          const fixturesFetchedAt = fixturesFetchedAtByFeed.get(feedKey) || 0;
          if (now - fixturesFetchedAt >= refreshInterval) {
            try {
              const fixtures = await fetchApiFootballFixtures(http, apiKey, feed, usageTracker);
              fixturesByFeed.set(feedKey, fixtures);
              fixturesFetchedAtByFeed.set(feedKey, now);
              if (feed.liveChannelId || feed.channelId) {
                await upsertMessage(feedKey, feed.liveChannelId || feed.channelId, 'live', buildApiFootballTournamentPayload(feed, fixtures, now));
              }
            } catch (error) {
              if (error.code === 'API_DAILY_LIMIT') {
                pausedUntilUtcDate = currentUtcDate;
                logger.warn('API-Football-Tageslimit erreicht; weitere API-Football-Aufrufe werden bis UTC-Mitternacht pausiert.');
                return;
              }
              fixturesFetchedAtByFeed.set(feedKey, now);
              logger.warn(`API-Football-Spielplan ${feed.name || feedKey} fehlgeschlagen: ${error.message}`);
            }
          }
        }

        const countdownChannelId = String(feed.countdownChannelId || feed.notificationChannelId || feed.liveChannelId || feed.channelId || '').trim();
        const countdownTeamId = Number(feed.countdownTeamId);
        const fixtures = fixturesByFeed.get(feedKey) || [];
        if (countdownChannelId && Number.isInteger(countdownTeamId) && countdownTeamId > 0) {
          const nextMatch = fixtures
            .filter(item => Number(item.teams?.home?.id) === countdownTeamId || Number(item.teams?.away?.id) === countdownTeamId)
            .filter(item => Date.parse(item.fixture?.date || '') > now
              && !['FT', 'AET', 'PEN', 'CANC', 'ABD', 'AWD', 'WO'].includes(item.fixture?.status?.short))
            .sort((a, b) => Date.parse(a.fixture.date) - Date.parse(b.fixture.date))[0];
          const match = toOpenLigaDbCountdownMatch(nextMatch);
          if (match) {
            try {
              const payload = await buildNextMatchCountdownMessage({
                leagueName: feed.name || nextMatch.league?.name,
                match,
                teamId: countdownTeamId,
                countdownStyle: feed.countdownStyle,
                countdownColor: feed.countdownColor,
                now,
              });
              await upsertMessage(feedKey, countdownChannelId, 'countdown', payload);
            } catch (error) {
              logger.warn(`API-Football-Countdown ${feed.name || feedKey} fehlgeschlagen: ${error.message}`);
            }
          }
        }

        const imageSettings = feed.finishedMatchImage || {};
        const notificationChannelId = String(feed.notificationChannelId || feed.liveChannelId || feed.channelId || '').trim();
        if (imageSettings.enabled && notificationChannelId) {
          for (const fixture of fixtures) {
            const fixtureId = Number(fixture.fixture?.id);
            const fixtureStatus = fixture.fixture?.status?.short;
            const matchKey = `${feedKey}:${fixtureId}`;
            const teamIds = [Number(fixture.teams?.home?.id), Number(fixture.teams?.away?.id)];
            if (!Number.isInteger(fixtureId) || !['FT', 'AET', 'PEN'].includes(fixtureStatus)
              || !teamIds.some(teamId => getFavoriteTeamIds(feed).includes(teamId))
              || announcedFinishedMatches.has(matchKey)) continue;
            try {
              const png = await buildApiFootballFinishedMatchGraphic(http, apiKey, feed, fixture, usageTracker);
              const channel = await getChannel(notificationChannelId);
              if (!channel) throw new Error('Ergebnisgrafik-Kanal ist nicht erreichbar.');
              await channel.send({
                content: `Ergebnisgrafik · ${fixture.teams?.home?.name || 'Heim'} ${Number(fixture.goals?.home) || 0}:${Number(fixture.goals?.away) || 0} ${fixture.teams?.away?.name || 'Auswärts'}`,
                files: [new AttachmentBuilder(png, { name: `api-football-${fixtureId}.png` })],
              });
              announcedFinishedMatches.add(matchKey);
            } catch (error) {
              if (error.code === 'API_DAILY_LIMIT') {
                pausedUntilUtcDate = currentUtcDate;
                logger.warn('API-Football-Tageslimit erreicht; weitere API-Football-Aufrufe werden bis UTC-Mitternacht pausiert.');
                return;
              }
              logger.warn(`API-Football-Ergebnisgrafik ${fixtureId} fehlgeschlagen: ${error.message}`);
            }
          }
        }

        const tableChannelId = String(feed.tableChannelId || '').trim();
        const standingsFetchedAt = standingsFetchedAtByFeed.get(feedKey) || 0;
        const refreshInterval = getApiFootballRefreshIntervalMs(feed);
        if (apiKey && tableChannelId && now - standingsFetchedAt >= refreshInterval) {
          try {
            const standings = await fetchApiFootballStandings(http, apiKey, feed, usageTracker);
            await upsertMessage(feedKey, tableChannelId, 'table', buildApiFootballStandingsPayload(feed, standings));
            standingsFetchedAtByFeed.set(feedKey, now);
          } catch (error) {
            if (error.code === 'API_DAILY_LIMIT') {
              pausedUntilUtcDate = currentUtcDate;
              logger.warn('API-Football-Tageslimit erreicht; weitere API-Football-Aufrufe werden bis UTC-Mitternacht pausiert.');
              return;
            }
            standingsFetchedAtByFeed.set(feedKey, now);
            logger.warn(`API-Football-Tabelle ${feed.name || feedKey} fehlgeschlagen: ${error.message}`);
          }
        }
      }

      const liveFeeds = feeds.filter(feed => feed.liveChannelId || feed.channelId || feed.notificationChannelId);
      const scheduledFixtures = liveFeeds.flatMap(feed => fixturesByFeed.get(`${feed.leagueId}:${feed.season}`) || []);
      const now = nowProvider();
      if (apiKey && liveFeeds.length && now - lastLivePollAt >= LIVE_POLL_INTERVAL_MS
        && hasApiFootballMatchWindow(scheduledFixtures, now)) {
        try {
          const liveFixtures = await fetchApiFootballLiveFixtures(http, apiKey, usageTracker);
          for (const feed of liveFeeds) {
            const feedKey = `${feed.leagueId}:${feed.season}`;
            const payload = buildApiFootballLivePayload(feed, liveFixtures, fixturesByFeed.get(feedKey) || [], now);
            await upsertMessage(feedKey, feed.liveChannelId || feed.channelId, 'live', payload);
            const favoriteIds = getFavoriteTeamIds(feed);
            const favoriteChannelId = String(feed.notificationChannelId || feed.liveChannelId || feed.channelId || '').trim();
            for (const fixture of liveFixtures) {
              if (Number(fixture.league?.id) !== Number(feed.leagueId)) continue;
              const homeId = Number(fixture.teams?.home?.id);
              const awayId = Number(fixture.teams?.away?.id);
              const favoriteHome = favoriteIds.includes(homeId);
              const favoriteAway = favoriteIds.includes(awayId);
              if (!favoriteHome && !favoriteAway) continue;
              await upsertMessage(feedKey, feed.liveChannelId || feed.channelId, `favorite-game:${fixture.fixture?.id}`, buildApiFootballFavoriteMatchPayload(feed, fixture));
              const scoreKey = `${feedKey}:${fixture.fixture?.id}`;
              const currentScores = new Map([
                [homeId, Number(fixture.goals?.home) || 0],
                [awayId, Number(fixture.goals?.away) || 0],
              ]);
              const previousScores = favoriteGoalScores.get(scoreKey);
              if (previousScores && favoriteChannelId) {
                for (const [teamId, score] of currentScores) {
                  if (!favoriteIds.includes(teamId) || score <= (previousScores.get(teamId) || 0)) continue;
                  const channel = await getChannel(favoriteChannelId);
                  if (channel) {
                    await channel.send({
                      content: `⚽ ${teamId === homeId ? fixture.teams?.home?.name : fixture.teams?.away?.name} trifft! ${fixture.teams?.home?.name} ${currentScores.get(homeId)}:${currentScores.get(awayId)} ${fixture.teams?.away?.name} · API-Football`,
                    });
                  }
                }
              }
              favoriteGoalScores.set(scoreKey, currentScores);
            }
          }
          lastLivePollAt = now;
        } catch (error) {
          if (error.code === 'API_DAILY_LIMIT') {
            pausedUntilUtcDate = currentUtcDate;
            logger.warn('API-Football-Tageslimit erreicht; weitere API-Football-Aufrufe werden bis UTC-Mitternacht pausiert.');
            return;
          }
          lastLivePollAt = now;
          logger.warn(`API-Football-Live-Feed fehlgeschlagen: ${error.message}`);
        }
      }

      for (const key of fixturesByFeed.keys()) {
        if (!activeKeys.has(key)) fixturesByFeed.delete(key);
      }
      for (const key of fixturesFetchedAtByFeed.keys()) {
        if (!activeKeys.has(key)) fixturesFetchedAtByFeed.delete(key);
      }
      for (const key of standingsFetchedAtByFeed.keys()) {
        if (!activeKeys.has(key)) standingsFetchedAtByFeed.delete(key);
      }
    } catch (error) {
      logger.warn(`API-Football-Watcher fehlgeschlagen: ${error.message}`);
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer) return;
      void checkOnce();
      timer = setInterval(checkOnce, CHECK_INTERVAL_MS);
      timer.unref?.();
      logger.info('API-Football-Watcher gestartet (Abrufintervall je Feed, Standard 24 Stunden)');
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    checkOnce,
  };
}

module.exports = {
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
  getApiFootballRefreshIntervalMs,
  hasApiFootballMatchWindow,
  normalizeApiFootballFeeds,
  parseApiFootballFeeds,
  shouldPollApiFootballFixtures,
};