'use strict';

/**
 * poll-option controller.
 *
 * `vote` counts one vote for an option of an open poll. The vote counts themselves are private
 * (admin only). Votes are limited per IP address and poll; the website additionally sets a cookie.
 */

const { createCoreController } = require('@strapi/strapi').factories;

const UID = 'api::poll-option.poll-option';
const MAX_VOTES = 5;
const WINDOW_MS = 60 * 60 * 1000;
const votesByIp = new Map(); // `${ip}|${pollId}` → { count, resetAt }

/** Counts the vote and tells whether the IP is still below the limit for this poll. */
const allowVote = (key) => {
  const now = Date.now();
  const entry = votesByIp.get(key);
  if (!entry || entry.resetAt < now) {
    votesByIp.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_VOTES) {
    return false;
  }
  entry.count++;
  return true;
};

module.exports = createCoreController(UID, ({ strapi }) => ({
  /** POST /api/poll-options/:documentId/vote */
  async vote(ctx) {
    const option = await strapi.documents(UID).findOne({
      documentId: ctx.params.documentId,
      populate: { poll: { fields: ['open'] } },
    });
    if (!option || !option.poll) {
      return ctx.notFound('Option nicht gefunden.');
    }
    if (!option.poll.open) {
      return ctx.conflict('Das Voting ist beendet.');
    }
    if (!allowVote(`${ctx.request.ip}|${option.poll.documentId}`)) {
      return ctx.tooManyRequests('Zu viele Stimmen. Bitte in einer Stunde erneut abstimmen.');
    }

    // Atomic increment, so concurrent votes are not lost.
    await strapi.db.connection('poll_options').where({ id: option.id }).increment('votes', 1);
    ctx.body = { ok: true };
  },
}));
