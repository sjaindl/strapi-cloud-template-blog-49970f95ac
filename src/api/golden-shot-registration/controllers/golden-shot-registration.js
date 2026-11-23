'use strict';

/**
 * golden-shot-registration controller.
 *
 * `register` takes the registration form of the Torschuss Challenge (multipart: fields + optional photo). It
 * stores the registration with its photo, adds the participant as option to the edition's voting (name and
 * photo only, contact data stays in the registration) and sends a mail to the club and a confirmation to the
 * participant.
 */

const { createCoreController } = require('@strapi/strapi').factories;
const { clubCc, clubMail, createRateLimiter, formatDate, isEmail, sendMail } = require('../../../utils/registrations');

const UID = 'api::golden-shot-registration.golden-shot-registration';
const allow = createRateLimiter(5, 60 * 60 * 1000);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHONE = /^[+]?[(]?[0-9]{1,4}[)]?[-\s./0-9]*$/;

/** Open when switched on (page active, registration on) and the deadline (inclusive) has not passed. */
const isOpen = (page) =>
  Boolean(page?.active && page.registrationOpen) && (!page.registrationDeadline || new Date().toISOString().slice(0, 10) <= page.registrationDeadline);

module.exports = createCoreController(UID, ({ strapi }) => ({
  /** POST /api/golden-shot-registrations/register (multipart: firstName, lastName, email, phone, website, photo) */
  async register(ctx) {
    const body = ctx.request.body ?? {};
    const field = (name) => String(body[name] ?? '').trim();
    const [firstName, lastName, email, phone] = ['firstName', 'lastName', 'email', 'phone'].map(field);
    const photo = ctx.request.files?.photo;

    // Bots fill in the hidden field; answer as if it worked, store nothing.
    if (field('website')) {
      ctx.body = { ok: true };
      return;
    }
    const nameOk = (value) => value.length >= 2 && value.length <= 25;
    if (!nameOk(firstName) || !nameOk(lastName) || !isEmail(email) || (phone && (phone.length < 10 || phone.length > 30 || !PHONE.test(phone)))) {
      return ctx.badRequest('Bitte Vor- und Nachname (je 2–25 Zeichen), eine gültige E-Mail und optional eine gültige Telefonnummer angeben.');
    }
    if (photo && (Array.isArray(photo) || !/^image\/(jpeg|png|webp|heic|heif)$/.test(photo.mimetype) || photo.size > MAX_PHOTO_BYTES)) {
      return ctx.badRequest('Das Foto muss ein Bild (JPG, PNG, WebP, HEIC) mit höchstens 10 MB sein.');
    }

    const page = await strapi.documents('api::golden-shot.golden-shot').findFirst({ populate: { poll: true } });
    if (!isOpen(page)) {
      return ctx.conflict('Die Anmeldung ist geschlossen.');
    }
    if (!allow(ctx.request.ip)) {
      return ctx.tooManyRequests('Zu viele Anmeldungen. Bitte in einer Stunde erneut versuchen.');
    }

    const name = `${firstName} ${lastName}`;
    let photoId = null;
    if (photo) {
      const [uploaded] = await strapi
        .plugin('upload')
        .service('upload')
        .upload({ data: { fileInfo: { name: photo.originalFilename, caption: name, alternativeText: name } }, files: photo });
      photoId = uploaded.id;
    }

    // The participant is a voting option right away (removable in the admin).
    const option = page.poll
      ? await strapi.documents('api::poll-option.poll-option').create({ data: { poll: page.poll.documentId, name, image: photoId } })
      : null;
    await strapi.documents(UID).create({
      data: { firstName, lastName, email, phone: phone || null, photo: photoId, edition: page.title, option: option?.documentId ?? null },
    });

    await sendMail(strapi, {
      to: clubMail(),
      cc: clubCc(),
      replyTo: email,
      subject: `Anmeldung ${page.title}: ${name}`,
      text: [`Name: ${name}`, `E-Mail: ${email}`, `Telefon: ${phone || '-'}`, `Foto: ${photo ? 'ja (im Admin bei der Anmeldung)' : 'nein'}`].join('\n'),
    });
    await sendMail(strapi, {
      to: email,
      replyTo: clubMail(),
      subject: `Deine Anmeldung zur ${page.title}`,
      text: [
        `Hallo ${firstName},`,
        '',
        `danke für deine Anmeldung zur ${page.title}!`,
        '',
        'Als Nächstes folgt das Online-Voting auf unserer Website: Die Top 3 ziehen ins Finale ein' +
          (page.finalDate ? ` und spielen am ${formatDate(page.finalDate)} um den Hauptpreis.` : ' und spielen um den Hauptpreis.'),
        '',
        `Bei Fragen sende einfach eine E-Mail an ${clubMail()}.`,
        '',
        'Sportliche Grüße',
        'HV TDP Stainz',
      ].join('\n'),
    });

    ctx.body = { ok: true };
  },
}));
