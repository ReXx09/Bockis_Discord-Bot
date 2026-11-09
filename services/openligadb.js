'use strict';

const { EmbedBuilder } = require('discord.js');

const API_BASE = 'https://api.openligadb.de';
const LEAGUE_SHORTCUT = 'bl1';
const POLL_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

function parseSettings(profile) {
  try {
    return JSON.parse(profile.settingsJson || '{}');
  } catch {
    return {};
  }
}

function getSeasonForLeague(leagues, leagueShortcut = LEAGUE_SHORTCUT) {
  const seasons = (Array.isArray(leagues) ? leagues : [])
    .filter(league => league.leagueShortcut === leagueShortcut && Number.isFinite(Number(league.leagueSeason)))
    .map(league => Number(league.leagueSeason));
  return seasons.length ? Math.max(...seasons) : null;
}

async function fetchLatestLeagueTeams(http, leagueShortcut = LEAGUE_SHORTCUT) {
  const leaguesResponse = await http.get(`${API_BASE}/getavailableleagues`, { timeout: REQUEST_TIMEOUT_MS });
  const season = getSeasonForLeague(leaguesResponse.data, leagueShortcut);
  if (season === null) throw new Error(`Keine Saison für ${leagueShortcut} gefunden`);

  const teamsResponse = await http.get(`${API_BASE}/getavailableteams/${encodeURIComponent(leagueShortcut)}/${season}`, { timeout: REQUEST_TIMEOUT_MS });
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

function buildScoreboardPayload({ group, matches, favoriteTeamIds, now = Date.now() }) {
  const favorites = new Set((favoriteTeamIds || []).map(Number));
  const favoriteMatches = (matches || [])
    .filter(match => favorites.has(match.team1?.teamId) || favorites.has(match.team2?.teamId))
    .sort((a, b) => Date.parse(a.matchDateTimeUTC || a.matchDateTime || '') - Date.parse(b.matchDateTimeUTC || b.matchDateTime || ''));

  const embed = new EmbedBuilder()
    .setColor(0xD6B32A)
    .setTitle(`⚽ 1. Fußball-Bundesliga${group?.groupName ? ` · ${group.groupName}` : ''}`)
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

function getGoalIds(match) {
  return new Set((match.goals || []).map(goal => String(goal.goalID)).filter(id => id !== 'undefined'));
}

function createOpenLigaDbWatcher({ http, client, ServerProfile, logger }) {
  let timer = null;
  let inFlight = false;
  let leagueCache = null;
  let feed = null;
  const eventStates = new Map();
  const boardMessages = new Map();
  const boardSignatures = new Map();

  async function getLatestSeason() {
    if (leagueCache && Date.now() - leagueCache.fetchedAt < 6 * 60 * 60 * 1000) return leagueCache.season;
    const response = await http.get(`${API_BASE}/getavailableleagues`, { timeout: REQUEST_TIMEOUT_MS });
    const season = getSeasonForLeague(response.data);
    if (season === null) throw new Error(`Keine aktuelle Saison für ${LEAGUE_SHORTCUT} gefunden`);
    leagueCache = { season, fetchedAt: Date.now() };
    return season;
  }

  async function loadFeed(season) {
    const groupResponse = await http.get(`${API_BASE}/getcurrentgroup/${LEAGUE_SHORTCUT}`, { timeout: REQUEST_TIMEOUT_MS });
    const group = groupResponse.data;
    if (!group || !Number.isInteger(group.groupOrderID)) throw new Error('OpenLigaDB lieferte keinen aktuellen Spieltag');

    const changedResponse = await http.get(`${API_BASE}/getlastchangedate/${LEAGUE_SHORTCUT}/${season}/${group.groupOrderID}`, { timeout: REQUEST_TIMEOUT_MS });
    const changedAt = String(changedResponse.data || '');
    const feedKey = `${season}:${group.groupOrderID}`;
    if (!feed || feed.key !== feedKey || feed.changedAt !== changedAt) {
      const matchesResponse = await http.get(`${API_BASE}/getmatchdata/${LEAGUE_SHORTCUT}/${season}/${group.groupOrderID}`, { timeout: REQUEST_TIMEOUT_MS });
      feed = { key: feedKey, changedAt, group, matches: Array.isArray(matchesResponse.data) ? matchesResponse.data : [] };
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

  async function findBoardMessage(channel, guildId) {
    const marker = `OpenLigaDB-Scoreboard:${guildId}`;
    const messages = await channel.messages.fetch({ limit: 50 });
    return messages.find(message => message.author.id === client.user.id
      && message.embeds.some(embed => embed.footer?.text.includes(marker))) || null;
  }

  async function updateBoard(profile, settings, currentFeed, favorites) {
    const channelId = String(settings.DISCORD_OPENLIGADB_CHANNEL_ID || '').trim();
    if (!channelId || !favorites.length) return;
    const channel = await getChannel(channelId);
    if (!channel) return;

    const payload = buildScoreboardPayload({ group: currentFeed.group, matches: currentFeed.matches, favoriteTeamIds: favorites });
    payload.embeds[0].setFooter({ text: `OpenLigaDB · ODbL 1.0 · OpenLigaDB-Scoreboard:${profile.guildId}` });
    const signature = JSON.stringify(payload.embeds[0].toJSON());
    if (boardSignatures.get(profile.guildId) === signature) return;

    let message = boardMessages.get(profile.guildId);
    if (!message) {
      try { message = await findBoardMessage(channel, profile.guildId); } catch {}
    }
    if (message) message = await message.edit(payload);
    else message = await channel.send(payload);
    boardMessages.set(profile.guildId, message);
    boardSignatures.set(profile.guildId, signature);
  }

  async function sendMatchEvents(profile, settings, currentFeed, favorites) {
    const channelId = String(settings.DISCORD_OPENLIGADB_CHANNEL_ID || '').trim();
    if (!channelId || !favorites.length) return;
    const channel = await getChannel(channelId);
    if (!channel) return;
    const favoriteSet = new Set(favorites);

    for (const match of currentFeed.matches) {
      const matchFavorites = [match.team1, match.team2].filter(team => favoriteSet.has(team?.teamId));
      if (!matchFavorites.length) continue;
      const stateKey = `${profile.guildId}:${match.matchID}`;
      const goalIds = getGoalIds(match);
      const previous = eventStates.get(stateKey);
      if (!previous) {
        eventStates.set(stateKey, { goalIds, finished: Boolean(match.matchIsFinished) });
        continue;
      }

      for (const goal of match.goals || []) {
        if (goalIds.has(String(goal.goalID)) && !previous.goalIds.has(String(goal.goalID))) {
          const [home, away] = getMatchScore(match);
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

  async function checkOnce() {
    if (inFlight) return;
    inFlight = true;
    try {
      const profiles = await ServerProfile.findAll({ attributes: ['guildId', 'settingsJson'] });
      const enabledProfiles = profiles.map(profile => ({ profile, settings: parseSettings(profile) }))
        .filter(({ settings }) => settings.DISCORD_OPENLIGADB_ENABLED === true || settings.DISCORD_OPENLIGADB_ENABLED === 'true');
      if (!enabledProfiles.length) return;

      const season = await getLatestSeason();
      const currentFeed = await loadFeed(season);
      for (const { profile, settings } of enabledProfiles) {
        const favorites = String(settings.DISCORD_OPENLIGADB_FAVORITES || '')
          .split(/[;,]/)
          .map(value => value.trim())
          .filter(Boolean)
          .map(Number)
          .filter(teamId => Number.isInteger(teamId) && teamId > 0);
        try {
          await updateBoard(profile, settings, currentFeed, favorites);
          await sendMatchEvents(profile, settings, currentFeed, favorites);
        } catch (error) {
          logger.warn(`OpenLigaDB für Guild ${profile.guildId} fehlgeschlagen: ${error.message}`);
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
  createOpenLigaDbWatcher,
  fetchLatestLeagueTeams,
  getMatchScore,
  getMatchStatus,
  getSeasonForLeague,
};