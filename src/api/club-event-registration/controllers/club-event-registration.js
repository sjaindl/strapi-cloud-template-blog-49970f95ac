'use strict';

/**
 * club-event-registration controller.
 *
 * `register` takes the registration form of an event page (team registration, or an order such as ducks for the
 * Entenrennen). It validates the input for the event's form type, stores the registration and sends one mail to
 * the club and a confirmation to the registrant (with the amount to pay and the bank details).
 */

const { createCoreController } = require('@strapi/strapi').factories;
const { clubCc, clubMail, createRateLimiter, formatDate, isEmail, sendMail } = require('../../../utils/registrations');

const UID = 'api::club-event-registration.club-event-registration';
const allow = createRateLimiter(5, 60 * 60 * 1000);
const PHONE = /^[+]?[(]?[0-9]{1,4}[)]?[-\s./0-9]*$/;
const MAX_QUANTITY = 100;

const formatEuro = (value) =>
  `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: Number.isInteger(Number(value)) ? 0 : 2, maximumFractionDigits: 2 }).format(value)} €`;

/** Open when the page is active, registration is switched on and the deadline (inclusive) has not passed. */
const isOpen = (event) =>
  Boolean(event?.active && event.registrationOpen) && (!event.registrationDeadline || new Date().toISOString().slice(0, 10) <= event.registrationDeadline);

module.exports = createCoreController(UID, ({ strapi }) => ({
  /** POST /api/club-event-registrations/register { event (slug), name, email, phone, teamName, address, quantity, website } */
  async register(ctx) {
    const body = ctx.request.body ?? {};
    const field = (name) => String(body[name] ?? '').trim();
    const [slug, name, email, phone, teamName, address] = ['event', 'name', 'email', 'phone', 'teamName', 'address'].map(field);

    // Bots fill in the hidden field; answer as if it worked, store nothing.
    if (field('website')) {
      ctx.body = { ok: true };
      return;
    }

    const event = slug ? await strapi.documents('api::club-event.club-event').findFirst({ filters: { slug } }) : null;
    if (!event) {
      return ctx.notFound('Veranstaltung nicht gefunden.');
    }

    const order = event.formType === 'order';
    const quantity = order ? Number(body.quantity) : null;
    const errors = [];
    if (name.length < 2 || name.length > 50) errors.push('Name (2–50 Zeichen)');
    if (!isEmail(email)) errors.push('gültige E-Mail');
    if ((order || event.phoneRequired || phone) && (phone.length < 10 || phone.length > 30 || !PHONE.test(phone))) errors.push('gültige Telefonnummer');
    if (!order && (!teamName || teamName.length > 100)) errors.push('Mannschaftsname');
    if (order && (address.length < 10 || address.length > 150)) errors.push('Adresse (10–150 Zeichen)');
    if (order && (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY)) errors.push(`Anzahl (1–${MAX_QUANTITY})`);
    if (errors.length) {
      return ctx.badRequest(`Bitte prüfe: ${errors.join(', ')}.`);
    }
    if (!isOpen(event)) {
      return ctx.conflict(order ? 'Die Bestellung ist geschlossen.' : 'Die Anmeldung ist geschlossen.');
    }
    if (!allow(ctx.request.ip)) {
      return ctx.tooManyRequests('Zu viele Anmeldungen. Bitte in einer Stunde erneut versuchen.');
    }

    const price = event.price === null || event.price === undefined ? null : Number(event.price);
    const amount = price === null ? null : order ? price * quantity : price;
    /** "1 Ente" / "5 Enten" */
    const units = (count) => `${count} ${count === 1 ? event.orderUnit || 'Stück' : event.orderUnitPlural || event.orderUnit || 'Stück'}`;
    await strapi.documents(UID).create({
      data: {
        event: event.documentId,
        edition: event.title,
        name,
        email,
        phone: phone || null,
        teamName: order ? null : teamName,
        address: order ? address : null,
        quantity,
        amount,
      },
    });

    const subjectName = order ? name : teamName;
    const details = order
      ? [`Name: ${name}`, `E-Mail: ${email}`, `Telefon: ${phone}`, `Adresse: ${address}`, `Anzahl: ${units(quantity)}`, amount !== null ? `Betrag: ${formatEuro(amount)}` : null]
      : [`Name: ${name}`, `E-Mail: ${email}`, phone ? `Telefon: ${phone}` : null, `Mannschaft: ${teamName}`];
    await sendMail(strapi, {
      to: clubMail(),
      cc: clubCc(),
      replyTo: email,
      subject: `${order ? 'Bestellung' : 'Anmeldung'} ${event.title}: ${subjectName}`,
      text: details.filter(Boolean).join('\n'),
    });

    // "Boccia 2026 + Mannschaftsname" / "Entenrennen 2025 + Name": the placeholder is filled in.
    const reference = event.paymentReference
      ? event.paymentReference.replace(order ? 'Name' : 'Mannschaftsname', subjectName)
      : subjectName;
    const payment = amount
      ? [
          '',
          order
            ? `Bitte überweise ${formatEuro(amount)} (${units(quantity)} à ${formatEuro(price)}):`
            : `Fix angemeldet ist dein Team erst nach Überweisung des Nenngelds von ${formatEuro(amount)}${
                event.registrationDeadline ? ` bis spätestens ${formatDate(event.registrationDeadline)}` : ''
              }:`,
          event.bankRecipient ? `Empfänger: ${event.bankRecipient}` : null,
          event.iban ? `IBAN: ${event.iban}` : null,
          event.bic ? `BIC: ${event.bic}` : null,
          `Verwendungszweck: ${reference}`,
        ]
      : [];
    await sendMail(strapi, {
      to: email,
      replyTo: clubMail(),
      subject: `Deine ${order ? 'Bestellung' : 'Anmeldung'} – ${event.title}`,
      text: [
        `Hallo ${name},`,
        '',
        order
          ? `danke für deine Bestellung von ${units(quantity)} zum ${event.title}!`
          : `danke für die Anmeldung der Mannschaft „${teamName}“ zum ${event.title}!`,
        '',
        event.date ? `Wann: ${formatDate(event.date)}${event.startTime ? `, ${event.startTime.slice(0, 5)} Uhr` : ''}` : null,
        event.location ? `Wo: ${event.location}` : null,
        ...payment,
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
}));
