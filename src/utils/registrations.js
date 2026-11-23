'use strict';

/**
 * Shared helpers of the public registration endpoints (Hallenturnier, Torschuss Challenge): mails via the email
 * plugin (only logged without SMTP_HOST), a per-IP rate limit and German date formatting.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isEmail = (value) => EMAIL.test(value);

/** Allows `max` calls per key within `windowMs`; returns a function key → boolean. */
function createRateLimiter(max, windowMs) {
  const entries = new Map(); // key → { count, resetAt }
  return (key) => {
    const now = Date.now();
    const entry = entries.get(key);
    if (!entry || entry.resetAt < now) {
      entries.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count++;
    return true;
  };
}

/** "2027-01-09" → "Sa, 09.01.2027" */
function formatDate(value) {
  if (!value) return '';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  const weekday = date.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '');
  return `${weekday}, ${date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
}

/** Club address that receives registrations (REGISTRATION_MAIL_TO) and the optional CC. */
const clubMail = () => process.env.REGISTRATION_MAIL_TO || 'hvtdpstainz@gmx.at';
const clubCc = () => process.env.REGISTRATION_MAIL_CC || undefined;

/** Sends a mail; without SMTP_HOST it is only logged. Failures are logged, never thrown. */
async function sendMail(strapi, mail) {
  if (!process.env.SMTP_HOST) {
    strapi.log.info(`[mail not sent, no SMTP_HOST] to=${mail.to} cc=${mail.cc ?? ''} replyTo=${mail.replyTo ?? ''} subject="${mail.subject}"\n${mail.text}`);
    return;
  }
  try {
    await strapi.plugin('email').service('email').send(mail);
  } catch (error) {
    strapi.log.error(`Mail "${mail.subject}" to ${mail.to} could not be sent: ${error.message}`);
  }
}

module.exports = { isEmail, createRateLimiter, formatDate, clubMail, clubCc, sendMail };
