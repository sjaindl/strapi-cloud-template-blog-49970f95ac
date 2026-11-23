'use strict';

/**
 * hallenturnier-registration controller.
 *
 * `register` takes the registration form of the website: it validates the input, stores the registration
 * and sends one mail to the club (as the old PHP script did) and a confirmation mail to the registrant with
 * the tournament details. A mail that cannot be sent is logged; the registration is kept either way.
 */

const { createCoreController } = require('@strapi/strapi').factories;

const { clubCc, clubMail, createRateLimiter, formatDate, isEmail, sendMail } = require('../../../utils/registrations');

const UID = 'api::hallenturnier-registration.hallenturnier-registration';
const allow = createRateLimiter(5, 60 * 60 * 1000);

const formatFee = (value) =>
  value === null || value === undefined ? '' : `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: Number.isInteger(Number(value)) ? 0 : 2 }).format(value)} €`;

/** Open when switched on and the deadline (inclusive) has not passed. */
const isOpen = (tournament) => {
  if (!tournament || tournament.registrationOpen === false) return false;
  if (!tournament.registrationDeadline) return true;
  return new Date().toISOString().slice(0, 10) <= tournament.registrationDeadline;
};

module.exports = createCoreController(UID, ({ strapi }) => {
  const send = (mail) => sendMail(strapi, mail);

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
      if (name.length < 2 || name.length > 25 || !isEmail(email) || !teamName || teamName.length > 100) {
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

      await send({
        to: clubMail(),
        cc: clubCc(),
        replyTo: email,
        subject: `Anmeldung ${tournament.title}: ${teamName}`,
        text: [`Name: ${name}`, `E-Mail: ${email}`, `Mannschaft: ${teamName}`].join('\n'),
      });

      const reference = tournament.paymentReference ? tournament.paymentReference.replace('Mannschaftsname', teamName) : teamName;
      await send({
        to: email,
        replyTo: clubMail(),
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
          `Bei Fragen sende einfach eine E-Mail an ${clubMail()}.`,
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
