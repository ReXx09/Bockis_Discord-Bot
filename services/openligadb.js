'use strict';

const { EmbedBuilder } = require('discord.js');

const API_BASE = 'https://api.openligadb.de';
const LEAGUE_SHORTCUT = 'bl1';
const POLL_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

let lastApiRequestAt = 0;
let apiQueue = Promise.resolve();

async function apiGet(http, url, requestIntervalMs = 1050) {
  const previous = apiQueue;
  let release;
  apiQueue = new Promise(resolve => { release = resolve; });
  await previous;
  const wait = Math.max(0, requestIntervalMs - (Date.now() - lastApiRequestAt));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastApiRequestAt = Date.now();
  try {
    return await http.get(url, { timeout: REQUEST_TIMEOUT_MS });
  } finally {
    release();
  }
}

function parseSettings(profile) {
  try {
    return JSON.parse(profile.settingsJson || '{}');
  } catch {
    return {};
  }
}

function getAvailableFootballLeagues(leagues) {
  const latest = new Map();
  for (const league of Array.isArray(leagues) ? leagues : []) {
    if (league?.sport?.sportId !== 1 || !league.leagueShortcut || !Number.isFinite(Number(league.leagueSeason))) continue;
    const season = Number(league.leagueSeason);
    const previous = latest.get(league.leagueShortcut);
    if (!previous || season > previous.season) {
      latest.set(league.leagueShortcut, {
        leagueShortcut: league.leagueShortcut,
        leagueSeason: season,
        leagueName: league.leagueName || league.leagueShortcut,
      });
    }
  }
  return Array.from(latest.values()).sort((a, b) => a.leagueName.localeCompare(b.leagueName, 'de'));
}

function getSeasonForLeague(leagues, leagueShortcut = LEAGUE_SHORTCUT) {
  const seasons = (Array.isArray(leagues) ? leagues : [])
    .filter(league => league.leagueShortcut === leagueShortcut && Number.isFinite(Number(league.leagueSeason)))
    .map(league => Number(league.leagueSeason));
  return seasons.length ? Math.max(...seasons) : null;
}

async function fetchAvailableLeagues(http, requestIntervalMs = 1050) {
  const response = await apiGet(http, `${API_BASE}/getavailableleagues`, requestIntervalMs);
  return getAvailableFootballLeagues(response.data);
}

async function fetchLatestLeagueTeams(http, leagueShortcut = LEAGUE_SHORTCUT, requestedSeason = null, requestIntervalMs = 1050) {
  let season = Number(requestedSeason);
  if (!Number.isFinite(season) || season < 1900) {
    const leaguesResponse = await apiGet(http, `${API_BASE}/getavailableleagues`, requestIntervalMs);
    season = getSeasonForLeague(leaguesResponse.data, leagueShortcut);
  }
  if (season === null) throw new Error(`Keine Saison für ${leagueShortcut} gefunden`);

  const teamsResponse = await apiGet(http, `${API_BASE}/getavailableteams/${encodeURIComponent(leagueShortcut)}/${season}`, requestIntervalMs);
  const teams = Array.isArray(teamsResponse.data) ? teamsResponse.data : [];
  return {
    leagueShortcut,
    season,
    teams: teams
      .filter(team => Number.isInteger(team.teamId) && team.teamName)
      .map(team => ({ teamId: team.teamId, teamName: team.teamName, shortName: team.shortName || team.teamName }))
      .sort((a, b) => a.teamName.localeCompare(b.teamName, 'de')),
  };
}

function getMatchScore(match) {
  const goals = Array.isArray(match?.goals) ? match.goals : [];
  if (goals.length) {
    const latestGoal = goals.reduce((latest, goal) => {
      const minute = Number(goal.matchMinute ?? -1);
      const latestMinute = Number(latest.matchMinute ?? -1);
      return minute > latestMinute ? goal : latest;
    });
    if (Number.isInteger(latestGoal.scoreTeam1) && Number.isInteger(latestGoal.scoreTeam2)) {
      return [latestGoal.scoreTeam1, latestGoal.scoreTeam2];
    }
  }

  const results = Array.isArray(match?.matchResults) ? match.matchResults : [];
  const result = results.find(item => ['AfterPenalties', 'AfterExtraTime', 'After90Minutes'].includes(item.resultTypeKind))
    || results.slice().sort((a, b) => (b.resultOrderID || 0) - (a.resultOrderID || 0))[0];
  if (result && Number.isInteger(result.pointsTeam1) && Number.isInteger(result.pointsTeam2)) {
    return [result.pointsTeam1, result.pointsTeam2];
  }
  return [0, 0];
}

function getMatchStatus(match, now = Date.now()) {
  if (match?.matchIsFinished) return 'Beendet';
  const start = Date.parse(match?.matchDateTimeUTC || match?.matchDateTime || '');
  if (Number.isFinite(start) && start <= now) return 'Läuft';
  if (Number.isFinite(start)) return `<t:${Math.floor(start / 1000)}:t>`;
  return 'Anstoß ausstehend';
}

function buildScoreboardPayload({ leagueName, group, matches, favoriteTeamIds, now = Date.now() }) {
  const favorites = new Set((favoriteTeamIds || []).map(Number));
  const favoriteMatches = (matches || [])
    .filter(match => favorites.has(match.team1?.teamId) || favorites.has(match.team2?.teamId))
    .sort((a, b) => Date.parse(a.matchDateTimeUTC || a.matchDateTime || '') - Date.parse(b.matchDateTimeUTC || b.matchDateTime || ''));

  const embed = new EmbedBuilder()
    .setColor(0xD6B32A)
    .setTitle(`⚽ ${leagueName || '1. Fußball-Bundesliga'}${group?.groupName ? ` · ${group.groupName}` : ''}`)
    .setFooter({ text: 'OpenLigaDB · Daten unter ODbL 1.0' });

  if (!favoriteMatches.length) {
    embed.setDescription('Für deine Favoriten stehen in diesem Spieltag keine Spiele an.');
  } else {
    embed.addFields(favoriteMatches.slice(0, 25).map(match => {
      const [home, away] = getMatchScore(match);
      const homeName = match.team1?.shortName || match.team1?.teamName || 'Heim';
      const awayName = match.team2?.shortName || match.team2?.teamName || 'Auswärts';
      const status = getMatchStatus(match, now);
      const goals = (match.goals || []).slice(-4).map(goal => {
        const minute = goal.matchMinute == null ? '' : ` ${goal.matchMinute}'`;
        return `${minute} ${goal.goalGetterName || 'Tor'}`.trim();
      }).join(' · ');
      return {
        name: `${homeName}  ${home} : ${away}  ${awayName}`.slice(0, 256),
        value: [status, goals].filter(Boolean).join('\n').slice(0, 1024),
        inline: false,
      };
    }));
  }

  return { embeds: [embed] };
}

function buildLiveTablePayload({ leagueName, table, matches, now = Date.now() }) {
  const standings = new Map((table || []).map(row => [Number(row.teamId), {
    ...row,
    matches: Number(row.matches) || 0,
    points: Number(row.points) || 0,
    goals: Number(row.goals) || 0,
    opponentGoals: Number(row.opponentGoals) || 0,
    won: Number(row.won) || 0,
    draw: Number(row.draw) || 0,
    lost: Number(row.lost) || 0,
  }]));

  for (const match of matches || []) {
    if (match.matchIsFinished) continue;
    const start = Date.parse(match.matchDateTimeUTC || match.matchDateTime || '');
    if (!Number.isFinite(start) || now < start || now - start > 160 * 60_000) continue;
    const home = standings.get(Number(match.team1?.teamId));
    const away = standings.get(Number(match.team2?.teamId));
    if (!home || !away) continue;
    const [homeGoals, awayGoals] = getMatchScore(match);
    home.matches += 1;
    away.matches += 1;
    home.goals += homeGoals;
    home.opponentGoals += awayGoals;
    away.goals += awayGoals;
    away.opponentGoals += homeGoals;
    if (homeGoals > awayGoals) {
      home.points += 3;
      home.won += 1;
      away.lost += 1;
    } else if (awayGoals > homeGoals) {
      away.points += 3;
      away.won += 1;
      home.lost += 1;
    } else {
      home.points += 1;
      away.points += 1;
      home.draw += 1;
      away.draw += 1;
    }
  }

  const rows = Array.from(standings.values()).sort((a, b) =>
    b.points - a.points
    || (b.goals - b.opponentGoals) - (a.goals - a.opponentGoals)
    || b.goals - a.goals
    || String(a.teamName).localeCompare(String(b.teamName), 'de'));
  const description = rows.map((row, index) => {
    const goalDifference = row.goals - row.opponentGoals;
    const teamName = row.shortName || row.teamName;
    return `**${String(index + 1).padStart(2, '0')}.** ${teamName} · ${row.points} P · ${row.goals}:${row.opponentGoals} (${goalDifference > 0 ? '+' : ''}${goalDifference}) · ${row.matches} Sp.`;
  }).join('\n').slice(0, 4000);

  const embed = new EmbedBuilder()
    .setColor(0xD6B32A)
    .setTitle(`📊 Live-Tabelle · ${leagueName || 'Bundesliga'}`)
    .setDescription(description || 'Noch keine Tabellendaten verfügbar.')
    .setFooter({ text: 'OpenLigaDB · Live-Hochrechnung laufender Spiele · ODbL 1.0' });
  return { embeds: [embed] };
}

function parseLeagueFeeds(settings) {
  const serialized = settings.DISCORD_OPENLIGADB_FEEDS;
  if (typeof serialized === 'string' && serialized.trim()) {
    try {
      const parsed = JSON.parse(serialized);
      if (Array.isArray(parsed)) {
        if (settings.DISCORD_OPENLIGADB_ENABLED === false || settings.DISCORD_OPENLIGADB_ENABLED === 'false') return [];
        return parsed.filter(feed => feed && typeof feed.leagueShortcut === 'string');
      }
    } catch {}
  }
  if (settings.DISCORD_OPENLIGADB_ENABLED === true || settings.DISCORD_OPENLIGADB_ENABLED === 'true') {
    return [{
      leagueShortcut: LEAGUE_SHORTCUT,
      favoriteTeamIds: String(settings.DISCORD_OPENLIGADB_FAVORITES || '').split(/[;,]/).map(Number).filter(id => Number.isInteger(id) && id > 0),
      notificationChannelId: String(settings.DISCORD_OPENLIGADB_CHANNEL_ID || ''),
      tableChannelIds: [],
    }];
  }
  return [];
}

function getGoalIds(match) {
  return new Set((match.goals || []).map(goal => String(goal.goalID)).filter(id => id !== 'undefined'));
}

function createOpenLigaDbWatcher({ http, client, ServerProfile, logger, requestIntervalMs = 1050 }) {
  let timer = null;
  let inFlight = false;
  let leagueCache = null;
  const feeds = new Map();
  const eventStates = new Map();
  const boardMessages = new Map();
  const boardSignatures = new Map();
  const tableMessages = new Map();
  const tableSignatures = new Map();

  async function getLeagueMetadata() {
    if (leagueCache && Date.now() - leagueCache.fetchedAt < 6 * 60 * 60 * 1000) return leagueCache.leagues;
    const leagues = await fetchAvailableLeagues(http, requestIntervalMs);
    leagueCache = { leagues, fetchedAt: Date.now() };
    return leagues;
  }

  async function loadFeed(leagueShortcut, season) {
    const groupResponse = await apiGet(http, `${API_BASE}/getcurrentgroup/${encodeURIComponent(leagueShortcut)}`, requestIntervalMs);
    const group = groupResponse.data;
    if (!group || !Number.isInteger(group.groupOrderID)) throw new Error('OpenLigaDB lieferte keinen aktuellen Spieltag');

    const changedResponse = await apiGet(http, `${API_BASE}/getlastchangedate/${encodeURIComponent(leagueShortcut)}/${season}/${group.groupOrderID}`, requestIntervalMs);
    const changedAt = String(changedResponse.data || '');
    const feedKey = `${leagueShortcut}:${season}:${group.groupOrderID}`;
    let feed = feeds.get(feedKey);
    if (!feed || feed.changedAt !== changedAt) {
      const matchesResponse = await apiGet(http, `${API_BASE}/getmatchdata/${encodeURIComponent(leagueShortcut)}/${season}/${group.groupOrderID}`, requestIntervalMs);
      const tableResponse = await apiGet(http, `${API_BASE}/getbltable/${encodeURIComponent(leagueShortcut)}/${season}`, requestIntervalMs);
      feed = {
        key: feedKey,
        changedAt,
        group,
        matches: Array.isArray(matchesResponse.data) ? matchesResponse.data : [],
        table: Array.isArray(tableResponse.data) ? tableResponse.data : [],
      };
      feeds.set(feedKey, feed);
    } else {
      feed.group = group;
    }
    return feed;
  }

  async function getChannel(channelId) {
    let channel = client.channels.cache.get(channelId);
    if (!channel) channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.() || !channel.messages || !channel.send) return null;
    return channel;
  }

  async function findMarkedMessage(channel, marker) {
    const messages = await channel.messages.fetch({ limit: 50 });
    return messages.find(message => message.author.id === client.user.id
      && message.embeds.some(embed => embed.footer?.text?.includes(marker))) || null;
  }

  async function upsertEmbedMessage({ profile, channelId, key, marker, payload, messages, signatures }) {
    channelId = String(channelId || '').trim();
    if (!channelId) return;
    const channel = await getChannel(channelId);
    if (!channel) return;
    const boardKey = `${profile.guildId}:${key}:${channelId}`;
    const footerText = payload.embeds[0].toJSON().footer?.text || 'OpenLigaDB · ODbL 1.0';
    payload.embeds[0].setFooter({ text: `${footerText} · ${marker}` });
    const signature = JSON.stringify(payload.embeds[0].toJSON());
    if (signatures.get(boardKey) === signature) return;

    let message = messages.get(boardKey);
    if (!message) try { message = await findMarkedMessage(channel, marker); } catch {}
    if (message) message = await message.edit(payload);
    else message = await channel.send(payload);
    messages.set(boardKey, message);
    signatures.set(boardKey, signature);
  }

  async function sendMatchEvents(profile, feedConfig, currentFeed, favoriteTeamIds) {
    const channelId = String(feedConfig.notificationChannelId || '').trim();
    if (!channelId || !favoriteTeamIds.length) return;
    const channel = await getChannel(channelId);
    if (!channel) return;
    const favoriteSet = new Set(favoriteTeamIds);
    const statePrefix = `${profile.guildId}:${feedConfig.leagueShortcut}:${currentFeed.key}`;

    for (const match of currentFeed.matches) {
      const matchFavorites = [match.team1, match.team2].filter(team => favoriteSet.has(team?.teamId));
      if (!matchFavorites.length) continue;
      const stateKey = `${statePrefix}:${match.matchID}`;
      const goalIds = getGoalIds(match);
      const previous = eventStates.get(stateKey);
      if (!previous) {
        eventStates.set(stateKey, { goalIds, finished: Boolean(match.matchIsFinished) });
        continue;
      }

      for (const goal of match.goals || []) {
        if (goalIds.has(String(goal.goalID)) && !previous.goalIds.has(String(goal.goalID))) {
          const home = Number.isInteger(goal.scoreTeam1) ? goal.scoreTeam1 : getMatchScore(match)[0];
          const away = Number.isInteger(goal.scoreTeam2) ? goal.scoreTeam2 : getMatchScore(match)[1];
          const minute = goal.matchMinute == null ? '' : ` (${goal.matchMinute}')`;
          await channel.send(`⚽ **Tor${minute}!** ${match.team1?.shortName || match.team1?.teamName} **${home}:${away}** ${match.team2?.shortName || match.team2?.teamName} · ${goal.goalGetterName || 'Torschütze unbekannt'}`);
        }
      }

      if (!previous.finished && match.matchIsFinished) {
        const [home, away] = getMatchScore(match);
        await channel.send(`🏁 **Abpfiff:** ${match.team1?.shortName || match.team1?.teamName} **${home}:${away}** ${match.team2?.shortName || match.team2?.teamName}`);
      }
      eventStates.set(stateKey, { goalIds, finished: Boolean(match.matchIsFinished) });
    }
  }

  async function updateLeague(profile, feedConfig, metadata, season) {
    const leagueShortcut = feedConfig.leagueShortcut;
    const leagueName = metadata?.leagueName || leagueShortcut;
    const currentFeed = await loadFeed(leagueShortcut, season);
    const favoriteTeamIds = (Array.isArray(feedConfig.favoriteTeamIds) ? feedConfig.favoriteTeamIds : [])
      .map(Number).filter(teamId => Number.isInteger(teamId) && teamId > 0);
    const feedKey = `${leagueShortcut}:${season}`;

    if (favoriteTeamIds.length && feedConfig.notificationChannelId) {
      const payload = buildScoreboardPayload({ leagueName, group: currentFeed.group, matches: currentFeed.matches, favoriteTeamIds });
      await upsertEmbedMessage({
        profile,
        channelId: feedConfig.notificationChannelId,
        key: `scoreboard:${feedKey}`,
        marker: `OpenLigaDB-Scoreboard:${profile.guildId}:${feedKey}`,
        payload,
        messages: boardMessages,
        signatures: boardSignatures,
      });
      await sendMatchEvents(profile, feedConfig, currentFeed, favoriteTeamIds);
    }

    const tableChannelIds = Array.isArray(feedConfig.tableChannelIds) ? [...new Set(feedConfig.tableChannelIds.map(id => String(id).trim()).filter(Boolean))] : [];
    if (tableChannelIds.length) {
      const payload = buildLiveTablePayload({ leagueName, table: currentFeed.table, matches: currentFeed.matches });
      for (const channelId of tableChannelIds) {
        await upsertEmbedMessage({
          profile,
          channelId,
          key: `table:${feedKey}`,
          marker: `OpenLigaDB-Tabelle:${profile.guildId}:${feedKey}`,
          payload,
          messages: tableMessages,
          signatures: tableSignatures,
        });
      }
    }
  }

  async function checkOnce() {
    if (inFlight) return;
    inFlight = true;
    try {
      const profiles = await ServerProfile.findAll({ attributes: ['guildId', 'settingsJson'] });
      const enabledProfiles = profiles.map(profile => ({ profile, settings: parseSettings(profile) }))
        .map(({ profile, settings }) => ({ profile, feeds: parseLeagueFeeds(settings) }));
      if (!enabledProfiles.some(({ feeds: configuredFeeds }) => configuredFeeds.length)) return;
      const metadataList = await getLeagueMetadata();
      const metadataByShortcut = new Map(metadataList.map(league => [league.leagueShortcut, league]));
      for (const { profile, feeds: configuredFeeds } of enabledProfiles) {
        for (const feedConfig of configuredFeeds) {
          const metadata = metadataByShortcut.get(feedConfig.leagueShortcut);
          const season = Number(feedConfig.season) || metadata?.leagueSeason;
          if (!Number.isFinite(season)) continue;
          try {
            await updateLeague(profile, feedConfig, metadata, season);
          } catch (error) {
            logger.warn(`OpenLigaDB ${feedConfig.leagueShortcut} für Guild ${profile.guildId} fehlgeschlagen: ${error.message}`);
          }
        }
      }
    } catch (error) {
      logger.warn(`OpenLigaDB-Abruf fehlgeschlagen: ${error.message}`);
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer) return;
      void checkOnce();
      timer = setInterval(checkOnce, POLL_INTERVAL_MS);
      timer.unref?.();
      logger.info(`OpenLigaDB-Watcher gestartet (Prüfung alle ${POLL_INTERVAL_MS / 1000}s)`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    checkOnce,
  };
}

module.exports = {
  buildScoreboardPayload,
  buildLiveTablePayload,
  createOpenLigaDbWatcher,
  fetchAvailableLeagues,
  fetchLatestLeagueTeams,
  getAvailableFootballLeagues,
  getMatchScore,
  getMatchStatus,
  getSeasonForLeague,
};