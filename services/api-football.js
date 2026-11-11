'use strict';

const { EmbedBuilder } = require('discord.js');
const { recordApiRequest } = require('./api-usage');

const API_BASE = 'https://v3.football.api-sports.io';
const REQUEST_TIMEOUT_MS = 10_000;
const CHECK_INTERVAL_MS = 60_000;
const API_POLL_LEAD_TIME_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_REFRESH_INTERVAL_MINUTES = 1440;
const MIN_REFRESH_INTERVAL_MINUTES = 60;
const MAX_REFRESH_INTERVAL_MINUTES = 1440;

function parseApiFootballFeeds(settings) {
  try {
    const feeds = typeof settings === 'string' ? JSON.parse(settings) : settings;
    return Array.isArray(feeds) ? feeds.filter(feed => feed && Number.isInteger(Number(feed.leagueId))
      && Number.isInteger(Number(feed.season)) && /^\d{5,24}$/.test(String(feed.channelId || ''))) : [];
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

function createApiFootballWatcher({ http, client, logger, getApiKey, getFeeds, nowProvider = () => Date.now() }) {
  let timer = null;
  let inFlight = false;
  let pausedUntilUtcDate = null;
  const lastPollAtByFeed = new Map();
  const messages = new Map();
  const signatures = new Map();

  async function getChannel(channelId) {
    let channel = client.channels.cache.get(String(channelId));
    if (!channel) channel = await client.channels.fetch(String(channelId));
    return channel?.isTextBased?.() && channel.messages && channel.send ? channel : null;
  }

  async function upsertMessage(feedKey, feed, payload) {
    const channelId = String(feed.channelId || '').trim();
    if (!channelId) return;
    const channel = await getChannel(channelId);
    if (!channel) return;
    const marker = `API-Football:${feedKey}`;
    const embed = payload.embeds[0];
    const footer = embed.toJSON().footer?.text || 'API-Football';
    embed.setFooter({ text: `${footer} · ${marker}` });
    const signature = JSON.stringify(embed.toJSON());
    const key = `${feedKey}:${channelId}`;
    if (signatures.get(key) === signature && messages.has(key)) return;

    let message = messages.get(key);
    if (!message) {
      const recent = await channel.messages.fetch({ limit: 50 });
      message = recent.find(candidate => candidate.author.id === client.user.id
        && candidate.embeds.some(existing => (existing.footer?.text || '').includes(marker)));
    }
    if (message) message = await message.edit({ embeds: [embed] });
    else message = await channel.send({ embeds: [embed] });
    messages.set(key, message);
    signatures.set(key, signature);
  }

  async function checkOnce() {
    if (inFlight) return;
    inFlight = true;
    try {
      const apiKey = String(getApiKey() || '').trim();
      const currentUtcDate = new Date(nowProvider()).toISOString().slice(0, 10);
      if (pausedUntilUtcDate === currentUtcDate) return;
      pausedUntilUtcDate = null;
      const activeKeys = new Set();
      for (const feed of parseApiFootballFeeds(getFeeds())) {
        const feedKey = `${feed.leagueId}:${feed.season}:${feed.channelId}`;
        activeKeys.add(feedKey);
        const now = nowProvider();
        const lastPollAt = lastPollAtByFeed.get(feedKey);
        if (lastPollAt !== undefined && now - lastPollAt < getApiFootballRefreshIntervalMs(feed)) continue;
        if (!shouldPollApiFootballFixtures(feed, now)) {
          try {
            await upsertMessage(feedKey, feed, buildApiFootballTournamentPayload(feed, [], now));
            lastPollAtByFeed.set(feedKey, now);
          } catch (error) {
            logger.warn(`API-Football-Countdown ${feed.name || feedKey} fehlgeschlagen: ${error.message}`);
            lastPollAtByFeed.set(feedKey, now);
          }
          continue;
        }
        if (!apiKey) {
          try {
            await upsertMessage(feedKey, feed, buildApiFootballTournamentPayload(feed, [], now));
          } catch (error) {
            logger.warn(`API-Football-Countdown ${feed.name || feedKey} fehlgeschlagen: ${error.message}`);
          }
          lastPollAtByFeed.set(feedKey, now);
          continue;
        }
        try {
          const fixtures = await fetchApiFootballFixtures(http, apiKey, feed);
          await upsertMessage(feedKey, feed, buildApiFootballTournamentPayload(feed, fixtures, now));
          lastPollAtByFeed.set(feedKey, now);
        } catch (error) {
          if (error.code === 'API_DAILY_LIMIT') {
            pausedUntilUtcDate = currentUtcDate;
            logger.warn('API-Football-Tageslimit erreicht; weitere API-Football-Aufrufe werden bis UTC-Mitternacht pausiert.');
            return;
          }
          logger.warn(`API-Football ${feed.name || feedKey} fehlgeschlagen: ${error.message}`);
          lastPollAtByFeed.set(feedKey, now);
        }
      }
      for (const key of lastPollAtByFeed.keys()) {
        if (!activeKeys.has(key)) lastPollAtByFeed.delete(key);
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
  buildApiFootballTournamentPayload,
  createApiFootballWatcher,
  fetchApiFootballFixtures,
  getApiFootballRefreshIntervalMs,
  parseApiFootballFeeds,
  shouldPollApiFootballFixtures,
};