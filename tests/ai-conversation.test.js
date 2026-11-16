const {
  assistantInvitesFollowUp,
  createAiFollowUpTracker,
} = require('../services/ai-conversation');

describe('AI conversation follow-ups', () => {
  test('keeps a follow-up open only for the same user and channel until timeout', () => {
    let currentTime = 1000;
    const tracker = createAiFollowUpTracker({ ttlMs: 3000, now: () => currentTime });
    const context = { guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' };

    tracker.refresh(context);
    expect(tracker.has(context)).toBe(true);
    expect(tracker.has({ ...context, userId: 'user-2' })).toBe(false);
    expect(tracker.has({ ...context, channelId: 'channel-2' })).toBe(false);

    currentTime = 4000;
    expect(tracker.has(context)).toBe(false);
  });

  test('can clear a pending follow-up and opens it only for a question', () => {
    const tracker = createAiFollowUpTracker();
    const context = { channelId: 'channel-1', userId: 'user-1' };
    tracker.refresh(context);
    tracker.clear(context);

    expect(tracker.has(context)).toBe(false);
    expect(assistantInvitesFollowUp('Wobei brauchst du Unterstützung?')).toBe(true);
    expect(assistantInvitesFollowUp('Ich kann dir dabei helfen.')).toBe(false);
  });
});
