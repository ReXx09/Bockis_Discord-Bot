'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE_PATH = path.join(__dirname, '..', 'data', 'api-usage.json');
const DEFAULT_LIMITS = Object.freeze({ openligadb: null, apiFootball: 100 });

function createApiUsageTracker({ filePath = DEFAULT_FILE_PATH, nowProvider = () => new Date(), dailyLimits = DEFAULT_LIMITS } = {}) {
  const limits = { ...dailyLimits };
  let state = null;

  function getDateKey() {
    const now = nowProvider();
    return (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  }

  function createEmptyState(date) {
    return { date, counts: { openligadb: 0, apiFootball: 0 } };
  }

  function loadState() {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (saved && typeof saved.date === 'string' && saved.counts && typeof saved.counts === 'object') {
        return {
          date: saved.date,
          counts: {
            openligadb: Number.isSafeInteger(saved.counts.openligadb) && saved.counts.openligadb >= 0 ? saved.counts.openligadb : 0,
            apiFootball: Number.isSafeInteger(saved.counts.apiFootball) && saved.counts.apiFootball >= 0 ? saved.counts.apiFootball : 0,
          },
        };
      }
    } catch {}
    return createEmptyState(getDateKey());
  }

  function persistState() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(temporaryPath, filePath);
    } catch {}
  }

  function rotateDay() {
    const date = getDateKey();
    if (!state || state.date !== date) {
      state = createEmptyState(date);
      persistState();
    }
  }

  function recordApiRequest(provider) {
    if (!Object.hasOwn(DEFAULT_LIMITS, provider)) throw new Error(`Unknown API provider: ${provider}`);
    rotateDay();
    const dailyLimit = limits[provider] ?? null;
    if (dailyLimit != null && state.counts[provider] >= dailyLimit) return false;
    state.counts[provider] += 1;
    persistState();
    return true;
  }

  function getUsageSnapshot() {
    rotateDay();
    return {
      dateUtc: state.date,
      totalRequests: Object.values(state.counts).reduce((total, count) => total + count, 0),
      providers: Object.fromEntries(Object.keys(DEFAULT_LIMITS).map(provider => {
        const dailyLimit = limits[provider] ?? null;
        const requests = state.counts[provider];
        return [provider, {
          requests,
          dailyLimit,
          remaining: dailyLimit == null ? null : Math.max(0, dailyLimit - requests),
        }];
      })),
    };
  }

  function setDailyLimit(provider, limit) {
    if (!Object.hasOwn(DEFAULT_LIMITS, provider)) throw new Error(`Unknown API provider: ${provider}`);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Daily API limit must be a positive integer.');
    limits[provider] = limit;
  }

  state = loadState();
  rotateDay();
  return { recordApiRequest, getUsageSnapshot, setDailyLimit };
}

const defaultTracker = createApiUsageTracker();

module.exports = {
  createApiUsageTracker,
  getApiUsageSnapshot: defaultTracker.getUsageSnapshot,
  recordApiRequest: defaultTracker.recordApiRequest,
  setApiUsageDailyLimit: defaultTracker.setDailyLimit,
};