function createAiFollowUpTracker({ ttlMs = 5 * 60 * 1000, now = Date.now } = {}) {
  const pendingFollowUps = new Map();

  function getKey({ guildId, channelId, userId }) {
    return JSON.stringify([guildId || null, channelId, userId]);
  }

  return {
    has(context) {
      const key = getKey(context);
      const expiresAt = pendingFollowUps.get(key);
      if (!expiresAt) return false;
      if (expiresAt <= now()) {
        pendingFollowUps.delete(key);
        return false;
      }
      return true;
    },
    refresh(context) {
      pendingFollowUps.set(getKey(context), now() + ttlMs);
    },
    clear(context) {
      pendingFollowUps.delete(getKey(context));
    },
  };
}

function assistantInvitesFollowUp(reply) {
  return String(reply || '').trim().endsWith('?');
}

module.exports = {
  assistantInvitesFollowUp,
  createAiFollowUpTracker,
};
