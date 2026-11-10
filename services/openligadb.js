'use strict';

const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { createHash } = require('crypto');
const sharp = require('sharp');

const API_BASE = 'https://api.openligadb.de';
const LEAGUE_SHORTCUT = 'bl1';
const POLL_INTERVAL_MS = 60_000;
const MIN_UPDATE_INTERVAL_MINUTES = 1;
const MAX_UPDATE_INTERVAL_MINUTES = 60;
const REQUEST_TIMEOUT_MS = 10_000;
const OPENLIGADB_COUNTDOWN_STYLES = Object.freeze([
  'classic',
  'compact',
  'detailed',
  'focus',
  'calendar',
  'matchday',
  'homeaway',
  'minimal',
  'competition',
  'spotlight',
  'live_timer',
  'graphic_timer',
]);

const COUNTDOWN_COLOR_PALETTE = Object.freeze({
  bl1: '#D6B32A',
  bl2: '#3498DB',
  bl3: '#8E44AD',
  dfb: '#E74C3C',
  ucl: '#5865F2',
  uel: '#F1C40F',
  uecl: '#2ECC71',
  unl: '#1ABC9C',
});

function getDefaultCountdownColor(leagueShortcut) {
  const shortcut = String(leagueShortcut || '').toLowerCase();
  const colorKey = ['ucl', 'uel', 'uecl', 'unl'].find(key => shortcut.startsWith(key)) || shortcut;
  if (COUNTDOWN_COLOR_PALETTE[colorKey]) return COUNTDOWN_COLOR_PALETTE[colorKey];
  const colors = Object.values(COUNTDOWN_COLOR_PALETTE);
  const index = Array.from(shortcut).reduce((total, character) => total + character.charCodeAt(0), 0) % colors.length;
  return colors[index];
}

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

function getFavoriteTeamIds(feedConfig) {
  const ids = [...new Set((Array.isArray(feedConfig?.favoriteTeamIds) ? feedConfig.favoriteTeamIds : [])
    .map(Number).filter(teamId => Number.isInteger(teamId) && teamId > 0))];
  const configuredLimit = Number(feedConfig?.maxFavorites);
  const limit = Number.isInteger(configuredLimit) && configuredLimit > 0
    ? Math.min(configuredLimit, 40)
    : Math.min(40, Math.max(5, ids.length));
  return ids.slice(0, limit);
}

function getOpenLigaDbUpdateIntervalMs(feedConfig) {
  const minutes = Number(feedConfig?.updateIntervalMinutes);
  if (!Number.isInteger(minutes) || minutes < MIN_UPDATE_INTERVAL_MINUTES || minutes > MAX_UPDATE_INTERVAL_MINUTES) {
    return POLL_INTERVAL_MS;
  }
  return minutes * 60_000;
}

function getDfbNationalTeamCategory(league) {
  const shortcut = String(league?.leagueShortcut || '').toLowerCase();
  const name = String(league?.leagueName || '');
  if (shortcut === 'u21dfb' || (/\bu21\b/i.test(name) && /\b(dfb|deutsch)/i.test(name))) return 'dfb-u21';
  if (shortcut === 'fna' || (/\b(frauen|women)\b/i.test(name) && /\bnational/i.test(name) && /\b(dfb|deutsch)/i.test(name))) return 'dfb-women';
  if (/\bnational/i.test(name) && /\b(dfb|deutsch)/i.test(name)) return 'dfb-men';
  return null;
}

function isExcludedCompetitionName(name) {
  return /\b(test|dummy|platzhalter|unused)\b/i.test(String(name || ''));
}

function getInternationalTournamentCategory(league) {
  const name = String(league?.leagueName || '');
  if (isExcludedCompetitionName(name) || /\b(u(?:1[0-9]|2[0-3])|junior|jugend|karten|klub|club)\b/i.test(name)) return null;
  const gender = /\b(frauen|women)\b/i.test(name) ? 'women' : 'men';
  if (/(europameisterschaft|uefa\s+euro\b|uefa\s+em)/i.test(name)) return `euro-${gender}`;
  if (/(weltmeisterschaft|world cup|\bwm\s*\d{2,4}\b)/i.test(name)) return `world-${gender}`;
  return null;
}

function getEuropeanCompetitionCategory(league) {
  const name = String(league?.leagueName || '');
  if (isExcludedCompetitionName(name)) return null;
  if (/\bconference league\b/i.test(name)) return 'conference-league';
  if (/\beuropa league\b/i.test(name)) return 'europa-league';
  if (/\bnations league\b/i.test(name)) return 'nations-league';
  return null;
}

function getTournamentEntryPriority(league, category, season) {
  const shortcut = String(league.leagueShortcut || '').toLowerCase();
  const name = String(league.leagueName || '');
  if (category.startsWith('euro-') && shortcut === `em${season}`) return 0;
  if (category.startsWith('world-') && shortcut === `wm${String(season).slice(-2)}` && /^wm\s*\d{4}$/i.test(name)) return 0;
  if (category.startsWith('euro-') && /^europameisterschaft\s+\d{4}$/i.test(name)) return 1;
  if (category.startsWith('world-') && /^fifa world cup\s+\d{4}$/i.test(name)) return 1;
  if (category.startsWith('world-') && /^wm\s*\d{4}$/i.test(name)) return 2;
  return 3;
}

function getEuropeanCompetitionEntryPriority(league, category, season) {
  const shortcut = String(league.leagueShortcut || '').toLowerCase();
  const name = String(league.leagueName || '');
  if (category === 'conference-league' && shortcut === `uecl${season}`) return 0;
  if (category === 'europa-league' && shortcut === `uel${season}`) return 0;
  if (category === 'nations-league' && shortcut === 'unl') return 0;
  if (category === 'conference-league' && /^conference league \d{4}\/\d{2}$/i.test(name)) return 1;
  if (category === 'europa-league' && /^europa league \d{4}\/\d{2}$/i.test(name)) return 1;
  if (category === 'nations-league' && /^nations league \d{4}\/\d{2}$/i.test(name)) return 1;
  return 2;
}

function getCoreLeagueCategory(league) {
  const shortcut = String(league?.leagueShortcut || '').toLowerCase();
  const name = String(league?.leagueName || '');
  if (isExcludedCompetitionName(name) || /\b(frauen|women)\b/i.test(name)) return null;
  if (/\bchampions league\b/i.test(name)) return 'champions-league';
  if (/\bdfb[-\s]*pokal\b/i.test(name)) return 'dfb-pokal';
  if (/^1\.\s*(?:fu(?:ß|ss)ball[\s-]*)?bundesliga\b/i.test(name)) return 'bundesliga-1';
  if (/^2\.\s*(?:fu(?:ß|ss)ball[\s-]*)?bundesliga\b/i.test(name)) return 'bundesliga-2';
  if (/\b3\.\s*liga\b/i.test(name)) return 'bundesliga-3';
  if (shortcut === 'bl1') return 'bundesliga-1';
  if (shortcut === 'bl2') return 'bundesliga-2';
  if (shortcut === 'bl3') return 'bundesliga-3';
  if (shortcut === 'dfb') return 'dfb-pokal';
  if (shortcut === 'ucl') return 'champions-league';
  return null;
}

function getCoreLeagueEntryPriority(league, category) {
  const preferredShortcuts = {
    'bundesliga-1': 'bl1',
    'bundesliga-2': 'bl2',
    'bundesliga-3': 'bl3',
    'dfb-pokal': 'dfb',
    'champions-league': 'ucl',
  };
  return String(league.leagueShortcut || '').toLowerCase() === preferredShortcuts[category] ? 0 : 1;
}

function getAvailableFootballLeagues(leagues, now = new Date()) {
  const latest = new Map();
  const nationalTeams = new Map();
  const tournaments = new Map();
  const europeanCompetitions = new Map();
  const coreCompetitions = new Map();
  const currentYear = now.getFullYear();
  const currentSeasonYears = new Set([currentYear]);
  if (now.getMonth() < 6) currentSeasonYears.add(currentYear - 1);
  for (const league of Array.isArray(leagues) ? leagues : []) {
    if (league?.sport?.sportId !== 1 || !league.leagueShortcut || !Number.isFinite(Number(league.leagueSeason))) continue;
    if (isExcludedCompetitionName(league.leagueName)) continue;
    const season = Number(league.leagueSeason);
    const nationalTeamCategory = getDfbNationalTeamCategory(league);
    if (nationalTeamCategory) {
      const previous = nationalTeams.get(nationalTeamCategory);
      if (!previous || season > Number(previous.leagueSeason)) nationalTeams.set(nationalTeamCategory, league);
      continue;
    }
    const tournamentCategory = getInternationalTournamentCategory(league);
    if (tournamentCategory) {
      if (tournamentCategory === 'euro-men' || tournamentCategory === 'world-men') {
        if (!tournaments.has(tournamentCategory)) tournaments.set(tournamentCategory, []);
        tournaments.get(tournamentCategory).push(league);
      }
      continue;
    }
    const europeanCompetitionCategory = getEuropeanCompetitionCategory(league);
    if (europeanCompetitionCategory) {
      if (!europeanCompetitions.has(europeanCompetitionCategory)) europeanCompetitions.set(europeanCompetitionCategory, []);
      europeanCompetitions.get(europeanCompetitionCategory).push(league);
      continue;
    }
    const coreCategory = getCoreLeagueCategory(league);
    if (coreCategory) {
      if (!currentSeasonYears.has(season)) continue;
      const key = `${coreCategory}:${season}`;
      if (!coreCompetitions.has(key)) coreCompetitions.set(key, []);
      coreCompetitions.get(key).push(league);
      continue;
    }
  }
  for (const [key, entries] of coreCompetitions) {
    const [category, seasonValue] = key.split(':');
    const season = Number(seasonValue);
    entries.sort((a, b) => getCoreLeagueEntryPriority(a, category) - getCoreLeagueEntryPriority(b, category));
    const league = entries[0];
    latest.set(league.leagueShortcut, {
      leagueShortcut: league.leagueShortcut,
      leagueSeason: season,
      leagueName: league.leagueName || league.leagueShortcut,
      leagueId: Number(league.leagueId) || undefined,
    });
  }
  for (const [category, entries] of europeanCompetitions) {
    const seasons = [...new Set(entries.map(league => Number(league.leagueSeason)))].sort((a, b) => a - b);
    for (const season of seasons.filter(year => year >= currentYear)) {
      const candidates = entries.filter(league => Number(league.leagueSeason) === season
        && !(category === 'nations-league' && /\bnations league\s+[abcd]\b/i.test(String(league.leagueName || ''))));
      if (!candidates.length) continue;
      candidates.sort((a, b) => getEuropeanCompetitionEntryPriority(a, category, season)
        - getEuropeanCompetitionEntryPriority(b, category, season));
      const league = candidates[0];
      latest.set(league.leagueShortcut, {
        leagueShortcut: league.leagueShortcut,
        leagueSeason: season,
        leagueName: league.leagueName || league.leagueShortcut,
        leagueId: Number(league.leagueId) || undefined,
      });
    }
  }
  for (const league of nationalTeams.values()) {
    latest.set(league.leagueShortcut, {
      leagueShortcut: league.leagueShortcut,
      leagueSeason: Number(league.leagueSeason),
      leagueName: league.leagueName || league.leagueShortcut,
      leagueId: Number(league.leagueId) || undefined,
    });
  }
  for (const [category, entries] of tournaments) {
    const seasons = [...new Set(entries.map(league => Number(league.leagueSeason)))].sort((a, b) => a - b);
    const includedSeasons = category.startsWith('euro-')
      ? [...new Set([
        ...seasons.filter(season => season >= currentYear),
        ...seasons.filter(season => season < currentYear).slice(-1),
      ])]
      : seasons.filter(season => season >= currentYear);
    for (const season of includedSeasons) {
      const candidates = entries.filter(league => Number(league.leagueSeason) === season);
      candidates.sort((a, b) => getTournamentEntryPriority(a, category, season) - getTournamentEntryPriority(b, category, season));
      const league = candidates[0];
      latest.set(league.leagueShortcut, {
        leagueShortcut: league.leagueShortcut,
        leagueSeason: season,
        leagueName: league.leagueName || league.leagueShortcut,
        leagueId: Number(league.leagueId) || undefined,
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

function buildNextMatchCountdownPayload({
  leagueName,
  match,
  teamId,
  teamInfo,
  countdownStyle = 'classic',
  countdownColor = '#D6B32A',
  now = Date.now(),
}) {
  const team = [match?.team1, match?.team2].find(candidate => Number(candidate?.teamId) === Number(teamId));
  const opponent = [match?.team1, match?.team2].find(candidate => candidate && candidate !== team);
  const teamName = team?.shortName || team?.teamName || teamInfo?.shortName || teamInfo?.teamName || 'Favorit';
  const matchTime = Date.parse(match?.matchDateTimeUTC || match?.matchDateTime || '');
  const style = OPENLIGADB_COUNTDOWN_STYLES.includes(countdownStyle) ? countdownStyle : 'classic';
  const normalizedColor = /^#[\da-f]{6}$/i.test(countdownColor) ? countdownColor : '#D6B32A';
  const embed = new EmbedBuilder()
    .setColor(Number.parseInt(normalizedColor.slice(1), 16))
    .setTitle(`⏳ Nächstes Spiel: ${teamName}`)
    .setFooter({ text: 'OpenLigaDB · Daten unter ODbL 1.0' });

  if (!match || match.matchIsFinished === true || !Number.isFinite(matchTime)) {
    embed.setDescription('Für diese Mannschaft ist derzeit kein nächstes Spiel terminiert.');
    if (style === 'graphic_timer') embed.setTitle('\u200b').setDescription('\u200b');
    return { embeds: [embed] };
  }
  if (matchTime <= now) {
    embed.setDescription(style === 'live_timer'
      ? '⚽ Das Spiel hat begonnen.'
      : 'Das nächste Spiel hat bereits begonnen; ein Countdown ist nicht mehr verfügbar.');
    if (style === 'graphic_timer') embed.setTitle('\u200b').setDescription('\u200b');
    return { embeds: [embed] };
  }

  const opponentName = opponent?.shortName || opponent?.teamName || 'Gegner offen';
  const timestamp = Math.floor(matchTime / 1000);
  const fullTime = `<t:${timestamp}:F>`;
  const relativeTime = `<t:${timestamp}:R>`;
  const matchLabel = `**${teamName} · ${opponentName}**`;
  const round = match.group?.groupName || '';
  const competition = [leagueName, round].filter(Boolean).join(' · ').slice(0, 1024);
  switch (style) {
    case 'compact':
      embed.setColor(0x5865F2)
        .setTitle(`⏳ ${teamName} · ${opponentName}`)
        .setDescription(`Anpfiff ${relativeTime}`);
      break;
    case 'detailed':
      embed.setTitle('📋 Nächstes Spiel')
        .setDescription(`${matchLabel}\n${fullTime}`)
        .addFields({ name: 'Countdown', value: relativeTime, inline: true });
      if (competition) embed.addFields({ name: 'Wettbewerb', value: competition, inline: true });
      break;
    case 'focus':
      embed.setColor(0xE67E22)
        .setTitle('⏱️ Anpfiff')
        .setDescription(`${relativeTime}\n${matchLabel}`)
        .addFields({ name: 'Termin', value: fullTime, inline: false });
      break;
    case 'calendar':
      embed.setColor(0x2ECC71)
        .setTitle('📅 Spieltermin')
        .setDescription(fullTime)
        .addFields(
          { name: 'Begegnung', value: `${teamName} · ${opponentName}`, inline: true },
          { name: 'Countdown', value: relativeTime, inline: true },
        );
      if (competition) embed.addFields({ name: 'Wettbewerb', value: competition, inline: false });
      break;
    case 'matchday':
      embed.setColor(0x8E44AD)
        .setTitle(`🏟️ ${round || 'Nächste Partie'}`)
        .setDescription(`${matchLabel}\nAnpfiff ${relativeTime}`);
      if (leagueName) embed.addFields({ name: 'Wettbewerb', value: String(leagueName).slice(0, 1024), inline: false });
      break;
    case 'homeaway': {
      const isHome = team === match.team1;
      embed.setColor(0x3498DB)
        .setTitle(isHome ? '🏠 Heimspiel' : '✈️ Auswärtsspiel')
        .setDescription(`${matchLabel}\nAnpfiff ${relativeTime}`)
        .addFields({ name: 'Datum und Uhrzeit', value: fullTime, inline: false });
      if (competition) embed.addFields({ name: 'Wettbewerb', value: competition, inline: false });
      break;
    }
    case 'minimal':
      embed.setColor(0x95A5A6)
        .setTitle(`${teamName} · ${opponentName}`)
        .setDescription(relativeTime);
      break;
    case 'competition':
      embed.setColor(0xF1C40F)
        .setTitle(`🏆 ${leagueName || 'Nächstes Spiel'}`)
        .setDescription(`${matchLabel}\nAnpfiff ${relativeTime}`);
      if (round) embed.addFields({ name: 'Spieltag', value: round, inline: true });
      embed.addFields({ name: 'Anstoß', value: fullTime, inline: true });
      break;
    case 'spotlight':
      embed.setColor(0x1ABC9C)
        .setAuthor({ name: `${teamName} · Countdown` })
        .setTitle('Nächste Partie')
        .setDescription(`**Gegen ${opponentName}**\n${relativeTime}\n${fullTime}`);
      if (competition) embed.addFields({ name: 'Wettbewerb', value: competition, inline: false });
      break;
    case 'live_timer': {
      const remainingMinutes = Math.max(0, Math.ceil((matchTime - now) / 60_000));
      const days = Math.floor(remainingMinutes / 1440);
      const hours = Math.floor((remainingMinutes % 1440) / 60);
      const minutes = remainingMinutes % 60;
      embed.setColor(0xE74C3C)
        .setTitle(`⏱️ Live-Countdown: ${teamName}`)
        .setDescription(`${matchLabel}\n**Noch ${days} Tage · ${hours} Std. · ${minutes} Min.**\n${fullTime}`);
      if (competition) embed.addFields({ name: 'Wettbewerb', value: competition, inline: false });
      break;
    }
    case 'graphic_timer':
      embed.setTitle('\u200b').setDescription('\u200b');
      break;
    default:
      embed.setDescription(`${matchLabel}\n${fullTime}\nAnpfiff ${relativeTime}`);
      if (competition) embed.addFields({ name: 'Wettbewerb', value: competition, inline: false });
      break;
  }
  embed.setColor(Number.parseInt(normalizedColor.slice(1), 16));
  return { embeds: [embed] };
}

function buildNextMatchCountdownSvg({ leagueName, match, teamId, teamInfo, countdownColor = '#D6B32A', now = Date.now() }) {
  const accent = /^#[\da-f]{6}$/i.test(countdownColor) ? countdownColor : '#D6B32A';
  const team = [match?.team1, match?.team2].find(candidate => Number(candidate?.teamId) === Number(teamId));
  const opponent = [match?.team1, match?.team2].find(candidate => candidate && candidate !== team);
  const teamName = fitSvgText(team?.shortName || team?.teamName || teamInfo?.shortName || teamInfo?.teamName || 'Favorit', 28);
  const opponentName = fitSvgText(opponent?.shortName || opponent?.teamName || 'Gegner offen', 28);
  const matchTime = Date.parse(match?.matchDateTimeUTC || match?.matchDateTime || '');
  const competition = fitSvgText(leagueName, 55);
  const hasUpcomingMatch = match && match.matchIsFinished !== true && Number.isFinite(matchTime) && matchTime > now;
  const remainingMinutes = hasUpcomingMatch ? Math.ceil((matchTime - now) / 60_000) : 0;
  const days = Math.floor(remainingMinutes / 1440);
  const hours = Math.floor((remainingMinutes % 1440) / 60);
  const minutes = remainingMinutes % 60;
  const status = hasUpcomingMatch
    ? `${days} TAGE  ·  ${hours} STD.  ·  ${minutes} MIN.`
    : match && Number.isFinite(matchTime) && matchTime <= now && match.matchIsFinished !== true
      ? 'DAS SPIEL LÄUFT'
      : 'DERZEIT KEIN SPIEL TERMINIERT';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="520" viewBox="0 0 1200 520">
    <defs>
      <linearGradient id="background" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#10141d"/><stop offset="1" stop-color="#242b3d"/></linearGradient>
      <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${accent}" stop-opacity=".45"/><stop offset="1" stop-color="${accent}"/></linearGradient>
    </defs>
    <rect width="1200" height="520" rx="26" fill="url(#background)"/>
    <rect x="0" y="0" width="14" height="520" rx="7" fill="url(#accent)"/>
    <circle cx="600" cy="210" r="205" fill="none" stroke="${accent}" stroke-opacity=".08" stroke-width="2"/>
    <text x="600" y="76" text-anchor="middle" fill="${accent}" font-family="Arial, sans-serif" font-size="24" font-weight="700" letter-spacing="5">NÄCHSTES SPIEL</text>
    <text x="600" y="126" text-anchor="middle" fill="#b9c0ce" font-family="Arial, sans-serif" font-size="22">${escapeSvgText(competition)}</text>
    <text x="330" y="232" text-anchor="middle" fill="#f5f6fa" font-family="Arial, sans-serif" font-size="42" font-weight="700">${escapeSvgText(teamName)}</text>
    <text x="600" y="232" text-anchor="middle" fill="${accent}" font-family="Arial, sans-serif" font-size="28" font-weight="700">VS</text>
    <text x="870" y="232" text-anchor="middle" fill="#f5f6fa" font-family="Arial, sans-serif" font-size="42" font-weight="700">${escapeSvgText(opponentName)}</text>
    <path d="M170 284h860" stroke="${accent}" stroke-opacity=".45" stroke-width="2"/>
    <text x="600" y="380" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="56" font-weight="800" letter-spacing="2">${escapeSvgText(status)}</text>
    <text x="600" y="468" text-anchor="middle" fill="#929bad" font-family="Arial, sans-serif" font-size="18">OpenLigaDB · Daten unter ODbL 1.0</text>
  </svg>`;
}

async function buildNextMatchCountdownPng(options) {
  return sharp(Buffer.from(buildNextMatchCountdownSvg(options))).png().toBuffer();
}

async function buildNextMatchCountdownMessage(options) {
  const payload = buildNextMatchCountdownPayload(options);
  if (options.countdownStyle === 'graphic_timer') {
    const png = await buildNextMatchCountdownPng(options);
    payload.files = [new AttachmentBuilder(png, { name: 'openligadb-countdown.png' })];
    payload.embeds[0].setImage('attachment://openligadb-countdown.png');
  }
  return payload;
}

function getKnockoutLoserId(match) {
  if (match.matchIsFinished !== true) return null;
  const result = ['AfterPenalties', 'AfterExtraTime', 'After90Minutes']
    .map(kind => (match.matchResults || []).find(item => item.resultTypeKind === kind))
    .find(Boolean);
  const [team1Score, team2Score] = result
    && Number.isInteger(result.pointsTeam1)
    && Number.isInteger(result.pointsTeam2)
    ? [result.pointsTeam1, result.pointsTeam2]
    : getMatchScore(match);
  if (team1Score === team2Score) return null;
  return Number(team1Score < team2Score ? match.team1?.teamId : match.team2?.teamId) || null;
}

function buildDfbPokalPayload({ leagueName, group, table, matches }) {
  const teams = new Map();
  for (const team of table || []) {
    const teamId = Number(team.teamId);
    if (Number.isInteger(teamId) && teamId > 0) teams.set(teamId, { ...team });
  }
  const eliminatedTeamIds = new Set();
  for (const match of matches || []) {
    for (const team of [match.team1, match.team2]) {
      const teamId = Number(team?.teamId);
      if (Number.isInteger(teamId) && teamId > 0) {
        teams.set(teamId, { ...teams.get(teamId), ...team });
      }
    }
    const loserId = getKnockoutLoserId(match);
    if (loserId) eliminatedTeamIds.add(loserId);
  }

  const remainingTeams = [...teams.entries()]
    .filter(([teamId]) => !eliminatedTeamIds.has(teamId))
    .map(([, team]) => team.shortName || team.teamName || 'Unbekanntes Team')
    .sort((a, b) => a.localeCompare(b, 'de'));
  const teamList = remainingTeams.map((teamName, index) =>
    `**${String(index + 1).padStart(2, '0')}.** ${teamName}`);
  const round = group?.groupName ? `**Aktuelle Runde:** ${group.groupName}\n\n` : '';
  const description = remainingTeams.length
    ? `${round}**${remainingTeams.length} Mannschaften noch im Wettbewerb**\n\n${teamList.join('\n')}`
    : `${round}Noch keine vertretenen Mannschaften verfügbar.`;

  return {
    embeds: [new EmbedBuilder()
      .setColor(0xD6B32A)
      .setTitle(`🏆 ${leagueName || 'DFB-Pokal'} · Noch vertreten`)
      .setDescription(description.slice(0, 4000))
      .setFooter({ text: 'OpenLigaDB · K.-o.-Übersicht · ODbL 1.0' })],
  };
}

function buildLiveTablePayload({ leagueShortcut, leagueName, group, table, matches, now = Date.now() }) {
  if (leagueShortcut === 'dfb') {
    return buildDfbPokalPayload({ leagueName, group, table, matches });
  }

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

function escapeSvgText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fitSvgText(value, maxLength = 34) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const characters = Array.from(text);
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength - 1).join('')}…`
    : text;
}

function buildFinishedMatchSvg({ leagueName, group, match, settings = {} }) {
  const templates = {
    stadium: { background: '#101b24', panel: '#1a2a35', accent: '#f5c400', text: '#ffffff', muted: '#b2c2cb' },
    classic: { background: '#101525', panel: '#202a40', accent: '#d8b15a', text: '#fffaf0', muted: '#c4c6ce' },
    minimal: { background: '#f1f3f5', panel: '#ffffff', accent: '#176b53', text: '#17212b', muted: '#566575' },
  };
  const palette = templates[settings.template] || templates.stadium;
  const [home, away] = getMatchScore(match);
  const team1 = fitSvgText(match.team1?.shortName || match.team1?.teamName || 'Heimteam');
  const team2 = fitSvgText(match.team2?.shortName || match.team2?.teamName || 'Auswärtsteam');
  const goals = (Array.isArray(match.goals) ? match.goals : [])
    .map(goal => {
      const scorer = String(goal.goalGetterName || '').trim();
      if (!scorer) return '';
      const minute = goal.matchMinute == null ? '' : ` ${goal.matchMinute}'`;
      return `${scorer}${minute}`;
    })
    .filter(Boolean);
  const scorerText = fitSvgText(goals.length > 4 ? `${goals.slice(0, 4).join(' · ')} · +${goals.length - 4}` : goals.join(' · '), 90);
  const matchDate = Date.parse(match.matchDateTimeUTC || match.matchDateTime || '');
  const dateText = Number.isFinite(matchDate)
    ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(matchDate)
    : '';
  const competition = fitSvgText(
    [leagueName, group?.groupName].filter(Boolean).join(' · '),
    70,
  );
  const showCompetition = settings.showCompetition !== false && competition;
  const showScorers = settings.showScorers !== false && scorerText;
  const showDate = settings.showDate === true && dateText;
  const decorativeShapes = settings.template === 'minimal'
    ? '<rect x="0" y="0" width="1200" height="14" fill="#176b53"/><circle cx="600" cy="330" r="220" fill="#f1f3f5"/>'
    : settings.template === 'classic'
      ? '<path d="M0 0h1200v18H0zM0 657h1200v18H0z" fill="#d8b15a"/><path d="M70 115h1060v435H70z" fill="#202a40" opacity=".8"/>'
      : '<path d="M0 560 1200 250v425H0z" fill="#142b30" opacity=".7"/><circle cx="600" cy="335" r="205" fill="#1a2a35" opacity=".92"/>';
  const infoLines = [
    showCompetition ? `<text x="600" y="108" text-anchor="middle" fill="${palette.muted}" font-size="25">${escapeSvgText(competition)}</text>` : '',
    `<text x="600" y="610" text-anchor="middle" fill="${palette.muted}" font-size="17">OpenLigaDB · ODbL 1.0</text>`,
    showScorers ? `<text x="600" y="500" text-anchor="middle" fill="${palette.text}" font-size="21">${escapeSvgText(`Torschützen: ${scorerText}`)}</text>` : '',
    showDate ? `<text x="600" y="548" text-anchor="middle" fill="${palette.muted}" font-size="20">${escapeSvgText(dateText)}</text>` : '',
  ].filter(Boolean).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
    <defs><linearGradient id="background" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette.background}"/><stop offset="1" stop-color="${palette.panel}"/></linearGradient></defs>
    <rect width="1200" height="675" fill="url(#background)"/>${decorativeShapes}
    <text x="600" y="72" text-anchor="middle" fill="${palette.accent}" font-size="25" font-weight="700" letter-spacing="5">ENDERGEBNIS</text>
    ${infoLines}
    <text x="300" y="290" text-anchor="middle" fill="${palette.text}" font-size="34" font-weight="700">${escapeSvgText(team1)}</text>
    <text x="900" y="290" text-anchor="middle" fill="${palette.text}" font-size="34" font-weight="700">${escapeSvgText(team2)}</text>
    <text x="480" y="390" text-anchor="middle" fill="${palette.accent}" font-size="96" font-weight="800">${home}</text>
    <text x="600" y="382" text-anchor="middle" fill="${palette.muted}" font-size="50">:</text>
    <text x="720" y="390" text-anchor="middle" fill="${palette.accent}" font-size="96" font-weight="800">${away}</text>
    <path d="M280 430h640" stroke="${palette.accent}" stroke-width="3" opacity=".8"/>
  </svg>`;
}

async function buildFinishedMatchPng({ leagueName, group, match, settings }) {
  return sharp(Buffer.from(buildFinishedMatchSvg({ leagueName, group, match, settings })))
    .png()
    .toBuffer();
}

async function buildFinishedMatchAttachment({ leagueName, group, match, settings }) {
  const image = await buildFinishedMatchPng({ leagueName, group, match, settings });
  return new AttachmentBuilder(image, { name: 'openligadb-endergebnis.png' });
}

function createOpenLigaDbWatcher({ http, client, ServerProfile, logger, requestIntervalMs = 1050, nowProvider = () => Date.now() }) {
  let timer = null;
  let inFlight = false;
  let leagueCache = null;
  const feeds = new Map();
  const eventStates = new Map();
  const boardMessages = new Map();
  const boardSignatures = new Map();
  const tableMessages = new Map();
  const tableSignatures = new Map();
  const countdownMessages = new Map();
  const countdownSignatures = new Map();
  const checkedDisabledCountdowns = new Set();
  const countdownChannelsByFeed = new Map();
  const liveCountdowns = new Map();
  const lastPollAtByFeed = new Map();

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
    if (!feed || feed.changedAt !== changedAt || leagueShortcut === 'dfb') {
      const matchesResponse = await apiGet(http, `${API_BASE}/getmatchdata/${encodeURIComponent(leagueShortcut)}/${season}/${group.groupOrderID}`, requestIntervalMs);
      const tableResponse = await apiGet(http, `${API_BASE}/getbltable/${encodeURIComponent(leagueShortcut)}/${season}`, requestIntervalMs);
      const allMatchesResponse = leagueShortcut === 'dfb'
        ? await apiGet(http, `${API_BASE}/getmatchdata/${encodeURIComponent(leagueShortcut)}/${season}`, requestIntervalMs)
        : matchesResponse;
      feed = {
        key: feedKey,
        changedAt,
        group,
        matches: Array.isArray(matchesResponse.data) ? matchesResponse.data : [],
        allMatches: Array.isArray(allMatchesResponse.data) ? allMatchesResponse.data : [],
        table: Array.isArray(tableResponse.data) ? tableResponse.data : [],
      };
      feeds.set(feedKey, feed);
    } else {
      feed.group = group;
    }
    return feed;
  }

  async function loadNextMatch(leagueId, teamId) {
    if (!Number.isInteger(Number(leagueId)) || Number(leagueId) <= 0) {
      throw new Error('OpenLigaDB-Liga-ID für den Countdown fehlt');
    }
    try {
      const response = await apiGet(http,
        `${API_BASE}/getnextmatchbyleagueteam/${Number(leagueId)}/${Number(teamId)}`,
        requestIntervalMs);
      return response.data || null;
    } catch (error) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async function getChannel(channelId) {
    let channel = client.channels.cache.get(channelId);
    if (!channel) channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.() || !channel.messages || !channel.send) return null;
    return channel;
  }

  async function findMarkedMessages(channel, marker) {
    const [markerType, ...markerParts] = marker.split(':');
    const feedKey = markerParts.slice(-2).join(':');
    const messages = await channel.messages.fetch({ limit: 50 });
    return messages.filter(message => message.author.id === client.user.id
      && message.embeds.some(embed => {
        const footer = embed.footer?.text || '';
        return footer.includes(marker)
          || (footer.includes(`${markerType}:`) && footer.endsWith(`:${feedKey}`));
      }));
  }

  async function upsertEmbedMessage({ profile, channelId, key, marker, payload, messages, signatures }) {
    channelId = String(channelId || '').trim();
    if (!channelId) return;
    const channel = await getChannel(channelId);
    if (!channel) return;
    const boardKey = `${profile.guildId}:${key}:${channelId}`;
    const footerText = payload.embeds[0].toJSON().footer?.text || 'OpenLigaDB · ODbL 1.0';
    payload.embeds[0].setFooter({ text: `${footerText} · ${marker}` });
    const fileSignatures = (payload.files || []).map(file => {
      const attachment = file.attachment;
      const data = Buffer.isBuffer(attachment) ? attachment : Buffer.from(String(attachment || ''));
      return createHash('sha256').update(data).digest('hex');
    });
    const signature = JSON.stringify({ embed: payload.embeds[0].toJSON(), files: fileSignatures });
    if (signatures.get(boardKey) === signature && messages.has(boardKey)) return;

    let message = messages.get(boardKey);
    let duplicateMessages = [];
    if (!message) {
      const existingMessages = await findMarkedMessages(channel, marker);
      [message, ...duplicateMessages] = existingMessages;
    }
    if (message) message = await message.edit({ ...payload, attachments: [] });
    else message = await channel.send(payload);
    messages.set(boardKey, message);
    signatures.set(boardKey, signature);
    const deleteResults = await Promise.allSettled(duplicateMessages.map(duplicate => duplicate.delete()));
    for (const result of deleteResults) {
      if (result.status === 'rejected') {
        logger.warn(`OpenLigaDB-Duplikat ${marker} konnte in Kanal ${channelId} nicht entfernt werden: ${result.reason.message}`);
      }
    }
  }

  async function clearCountdownMessage(profile, channelId, feedKey) {
    channelId = String(channelId || '').trim();
    if (!channelId) return;
    const key = `${profile.guildId}:countdown:${feedKey}:${channelId}`;
    if (checkedDisabledCountdowns.has(key)) return;
    checkedDisabledCountdowns.add(key);
    try {
      const channel = await getChannel(channelId);
      if (!channel) return;
      const marker = `OpenLigaDB-Countdown:${feedKey}`;
      const markedMessages = await findMarkedMessages(channel, marker);
      const messagesToDelete = new Set(markedMessages);
      const cachedMessage = countdownMessages.get(key);
      if (cachedMessage) messagesToDelete.add(cachedMessage);
      await Promise.all(Array.from(messagesToDelete, message => message.delete()));
      countdownMessages.delete(key);
      countdownSignatures.delete(key);
    } catch (error) {
      logger.warn(`OpenLigaDB-Countdown für ${feedKey} konnte nicht entfernt werden: ${error.message}`);
    }
  }

  async function sendMatchEvents(profile, feedConfig, currentFeed, favoriteTeamIds, leagueName) {
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
        if (feedConfig.finishedMatchImage?.enabled === true) {
          const attachment = await buildFinishedMatchAttachment({
            leagueName,
            group: currentFeed.group,
            match,
            settings: feedConfig.finishedMatchImage,
          });
          await channel.send({
            content: `🏁 **Endergebnis:** ${match.team1?.shortName || match.team1?.teamName} **${home}:${away}** ${match.team2?.shortName || match.team2?.teamName}`,
            files: [attachment],
          });
        } else {
          await channel.send(`🏁 **Abpfiff:** ${match.team1?.shortName || match.team1?.teamName} **${home}:${away}** ${match.team2?.shortName || match.team2?.teamName}`);
        }
      }
      eventStates.set(stateKey, { goalIds, finished: Boolean(match.matchIsFinished) });
    }
  }

  async function updateLeague(profile, feedConfig, metadata, season) {
    const leagueShortcut = feedConfig.leagueShortcut;
    const leagueName = metadata?.leagueName || leagueShortcut;
    const currentFeed = await loadFeed(leagueShortcut, season);
    const favoriteTeamIds = getFavoriteTeamIds(feedConfig);
    const feedKey = `${leagueShortcut}:${season}`;

    if (favoriteTeamIds.length && feedConfig.notificationChannelId) {
      const payload = buildScoreboardPayload({ leagueName, group: currentFeed.group, matches: currentFeed.matches, favoriteTeamIds });
      await upsertEmbedMessage({
        profile,
        channelId: feedConfig.notificationChannelId,
        key: `scoreboard:${feedKey}`,
        marker: `OpenLigaDB-Scoreboard:${feedKey}`,
        payload,
        messages: boardMessages,
        signatures: boardSignatures,
      });
      await sendMatchEvents(profile, feedConfig, currentFeed, favoriteTeamIds, leagueName);
    }

    const countdownTeamId = Number(feedConfig.countdownTeamId);
    const countdownKey = `${leagueShortcut}:${season}`;
    const countdownStateKey = `${profile.guildId}:${countdownKey}`;
    const countdownChannelId = String(feedConfig.countdownChannelId || feedConfig.notificationChannelId || '').trim();
    if (Number.isInteger(countdownTeamId) && favoriteTeamIds.includes(countdownTeamId) && countdownChannelId) {
      const previousChannelId = countdownChannelsByFeed.get(countdownStateKey);
      const legacyChannelId = String(feedConfig.notificationChannelId || '').trim();
      for (const obsoleteChannelId of new Set([previousChannelId, legacyChannelId].filter(channelId => channelId && channelId !== countdownChannelId))) {
        await clearCountdownMessage(profile, obsoleteChannelId, countdownKey);
      }
      countdownChannelsByFeed.set(countdownStateKey, countdownChannelId);
      const nextMatch = await loadNextMatch(metadata?.leagueId, countdownTeamId);
      const teamInfo = currentFeed.table.find(team => Number(team.teamId) === countdownTeamId);
      const countdownStyle = feedConfig.countdownStyle || 'classic';
      const countdownColor = feedConfig.countdownColor || getDefaultCountdownColor(leagueShortcut);
      const payload = await buildNextMatchCountdownMessage({
        leagueName,
        match: nextMatch,
        teamId: countdownTeamId,
        teamInfo,
        countdownStyle,
        countdownColor,
        now: nowProvider(),
      });
      const marker = `OpenLigaDB-Countdown:${countdownKey}`;
      const messageKey = `${profile.guildId}:countdown:${countdownKey}:${countdownChannelId}`;
      checkedDisabledCountdowns.delete(messageKey);
      await upsertEmbedMessage({
        profile,
        channelId: countdownChannelId,
        key: `countdown:${countdownKey}`,
        marker,
        payload,
        messages: countdownMessages,
        signatures: countdownSignatures,
      });
      if (['live_timer', 'graphic_timer'].includes(countdownStyle)) {
        liveCountdowns.set(countdownStateKey, {
          profile,
          channelId: countdownChannelId,
          countdownKey,
          leagueName,
          match: nextMatch,
          teamId: countdownTeamId,
          teamInfo,
          countdownStyle,
          countdownColor,
        });
      } else {
        liveCountdowns.delete(countdownStateKey);
      }
    } else {
      liveCountdowns.delete(countdownStateKey);
      const previousChannelId = countdownChannelsByFeed.get(countdownStateKey);
      const candidateChannelIds = new Set([
        previousChannelId,
        feedConfig.countdownChannelId,
        feedConfig.notificationChannelId,
      ].map(channelId => String(channelId || '').trim()).filter(Boolean));
      for (const channelId of candidateChannelIds) {
        await clearCountdownMessage(profile, channelId, countdownKey);
      }
      countdownChannelsByFeed.delete(countdownStateKey);
    }

    const tableChannelIds = Array.isArray(feedConfig.tableChannelIds) ? [...new Set(feedConfig.tableChannelIds.map(id => String(id).trim()).filter(Boolean))] : [];
    if (tableChannelIds.length) {
      const payload = buildLiveTablePayload({
        leagueShortcut,
        leagueName,
        group: currentFeed.group,
        table: currentFeed.table,
        matches: leagueShortcut === 'dfb' ? currentFeed.allMatches : currentFeed.matches,
      });
      for (const channelId of tableChannelIds) {
        await upsertEmbedMessage({
          profile,
          channelId,
          key: `table:${feedKey}`,
          marker: `OpenLigaDB-Tabelle:${feedKey}`,
          payload,
          messages: tableMessages,
          signatures: tableSignatures,
        });
      }
    }
  }

  async function refreshLiveCountdowns() {
    for (const countdown of liveCountdowns.values()) {
      try {
        const payload = await buildNextMatchCountdownMessage({
          leagueName: countdown.leagueName,
          match: countdown.match,
          teamId: countdown.teamId,
          teamInfo: countdown.teamInfo,
          countdownStyle: countdown.countdownStyle,
          countdownColor: countdown.countdownColor,
          now: nowProvider(),
        });
        await upsertEmbedMessage({
          profile: countdown.profile,
          channelId: countdown.channelId,
          key: `countdown:${countdown.countdownKey}`,
          marker: `OpenLigaDB-Countdown:${countdown.countdownKey}`,
          payload,
          messages: countdownMessages,
          signatures: countdownSignatures,
        });
      } catch (error) {
        logger.warn(`OpenLigaDB-Live-Countdown für ${countdown.countdownKey} konnte nicht aktualisiert werden: ${error.message}`);
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
      if (!enabledProfiles.some(({ feeds: configuredFeeds }) => configuredFeeds.length)) {
        lastPollAtByFeed.clear();
        liveCountdowns.clear();
        return;
      }
      const metadataList = await getLeagueMetadata();
      const metadataByShortcut = new Map(metadataList.map(league => [league.leagueShortcut, league]));
      const activeFeedKeys = new Set();
      for (const { profile, feeds: configuredFeeds } of enabledProfiles) {
        for (const feedConfig of configuredFeeds) {
          const metadata = metadataByShortcut.get(feedConfig.leagueShortcut);
          if (!metadata) continue;
          const season = metadata.leagueSeason;
          if (!Number.isFinite(season)) continue;
          const feedKey = `${profile.guildId}:${feedConfig.leagueShortcut}:${Number(feedConfig.season) || season}`;
          activeFeedKeys.add(feedKey);
          const now = nowProvider();
          const lastPollAt = lastPollAtByFeed.get(feedKey);
          if (lastPollAt !== undefined && now - lastPollAt < getOpenLigaDbUpdateIntervalMs(feedConfig)) continue;
          lastPollAtByFeed.set(feedKey, now);
          try {
            await updateLeague(profile, feedConfig, metadata, season);
          } catch (error) {
            logger.warn(`OpenLigaDB ${feedConfig.leagueShortcut} für Guild ${profile.guildId} fehlgeschlagen: ${error.message}`);
          }
        }
      }
      for (const feedKey of lastPollAtByFeed.keys()) {
        if (!activeFeedKeys.has(feedKey)) lastPollAtByFeed.delete(feedKey);
      }
      for (const feedKey of liveCountdowns.keys()) {
        if (!activeFeedKeys.has(feedKey)) liveCountdowns.delete(feedKey);
      }
      await refreshLiveCountdowns();
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
  buildFinishedMatchPng,
  buildNextMatchCountdownMessage,
  buildNextMatchCountdownPng,
  buildNextMatchCountdownPayload,
  buildLiveTablePayload,
  createOpenLigaDbWatcher,
  fetchAvailableLeagues,
  fetchLatestLeagueTeams,
  getAvailableFootballLeagues,
  getFavoriteTeamIds,
  getDefaultCountdownColor,
  getOpenLigaDbUpdateIntervalMs,
  getMatchScore,
  getMatchStatus,
  getSeasonForLeague,
  OPENLIGADB_COUNTDOWN_STYLES,
};