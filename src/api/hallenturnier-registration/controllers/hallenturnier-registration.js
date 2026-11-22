'use strict';

/**
 * hallenturnier-registration controller.
 *
 * `register` takes the registration form of the website: it validates the input, stores the registration
 * and sends one mail to the club (as the old PHP script did) and a confirmation mail to the registrant with
 * the tournament details. A mail that cannot be sent is logged; the registration is kept either way.
 */

const { createCoreController } = require('@strapi/strapi').factories;

const UID = 'api::hallenturnier-registration.hallenturnier-registration';
const MAX_PER_HOUR = 5;
const registrationsByIp = new Map(); // ip → { count, resetAt }
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const allow = (ip) => {
  const now = Date.now();
  const entry = registrationsByIp.get(ip);
  if (!entry || entry.resetAt < now) {
    registrationsByIp.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= MAX_PER_HOUR) return false;
  entry.count++;
  return true;
};

/** "2027-01-09" → "Sa, 09.01.2027" */
const formatDate = (value) => {
  if (!value) return '';
  const date = new Date(`${value}T12:00:00`);
  const weekday = date.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '');
  return `${weekday}, ${date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
};

const formatFee = (value) =>
  value === null || value === undefined ? '' : `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: Number.isInteger(Number(value)) ? 0 : 2 }).format(value)} €`;

/** Open when switched on and the deadline (inclusive) has not passed. */
const isOpen = (tournament) => {
  if (!tournament || tournament.registrationOpen === false) return false;
  if (!tournament.registrationDeadline) return true;
  return new Date().toISOString().slice(0, 10) <= tournament.registrationDeadline;
};

module.exports = createCoreController(UID, ({ strapi }) => {
  const send = async (mail) => {
    if (!process.env.SMTP_HOST) {
      strapi.log.info(`[mail not sent, no SMTP_HOST] to=${mail.to} cc=${mail.cc ?? ''} replyTo=${mail.replyTo ?? ''} subject="${mail.subject}"\n${mail.text}`);
      return;
    }
    try {
      await strapi.plugin('email').service('email').send(mail);
    } catch (error) {
      strapi.log.error(`Mail "${mail.subject}" to ${mail.to} could not be sent: ${error.message}`);
    }
  };

  return {
    /** POST /api/hallenturnier-registrations/register { name, email, teamName, website (honeypot) } */
    async register(ctx) {
      const body = ctx.request.body ?? {};
      const name = String(body.name ?? '').trim();
      const email = String(body.email ?? '').trim();
      const teamName = String(body.teamName ?? '').trim();

      // Bots fill in the hidden field; answer as if it worked, store nothing.
      if (body.website) {
        ctx.body = { ok: true };
        return;
      }
      if (name.length < 2 || name.length > 25 || !EMAIL.test(email) || !teamName || teamName.length > 100) {
        return ctx.badRequest('Bitte Name (2–25 Zeichen), eine gültige E-Mail und den Mannschaftsnamen angeben.');
      }

      const tournament = await strapi.documents('api::hallenturnier.hallenturnier').findFirst({});
      if (!isOpen(tournament)) {
        return ctx.conflict('Die Anmeldung ist geschlossen.');
      }
      if (!allow(ctx.request.ip)) {
        return ctx.tooManyRequests('Zu viele Anmeldungen. Bitte in einer Stunde erneut versuchen.');
      }

      await strapi.documents(UID).create({ data: { name, email, teamName, edition: tournament.title } });

      const clubMail = process.env.REGISTRATION_MAIL_TO || 'hvtdpstainz@gmx.at';
      await send({
        to: clubMail,
        cc: process.env.REGISTRATION_MAIL_CC || undefined,
        replyTo: email,
        subject: `Anmeldung ${tournament.title}: ${teamName}`,
        text: [`Name: ${name}`, `E-Mail: ${email}`, `Mannschaft: ${teamName}`].join('\n'),
      });

      const reference = tournament.paymentReference ? tournament.paymentReference.replace('Mannschaftsname', teamName) : teamName;
      await send({
        to: email,
        replyTo: clubMail,
        subject: `Deine Anmeldung zum ${tournament.title}`,
        text: [
          `Hallo ${name},`,
          '',
          `danke für die Anmeldung der Mannschaft „${teamName}“ zum ${tournament.title}!`,
          '',
          `Wann: ${formatDate(tournament.date)}${tournament.dateHint ? ` (${tournament.dateHint})` : ''}`,
          tournament.location ? `Wo: ${tournament.location}` : null,
          tournament.format ? `Spielform: ${tournament.format}` : null,
          '',
          `Fix angemeldet ist dein Team erst nach Überweisung des Nenngelds${tournament.entryFee ? ` von ${formatFee(tournament.entryFee)}` : ''}${
            tournament.registrationDeadline ? ` bis spätestens ${formatDate(tournament.registrationDeadline)}` : ''
          }:`,
          tournament.bankRecipient ? `Empfänger: ${tournament.bankRecipient}` : null,
          tournament.iban ? `IBAN: ${tournament.iban}` : null,
          `Verwendungszweck: ${reference}`,
          '',
          `Bei Fragen sende einfach eine E-Mail an ${clubMail}.`,
          '',
          'Sportliche Grüße',
          'HV TDP Stainz',
        ]
          .filter((line) => line !== null)
          .join('\n'),
      });

      ctx.body = { ok: true };
    },
  };
});
