'use strict';

/**
 * Migrates the page texts the website kept in code into Strapi:
 *   the Hallenturnier page (single type `hallenturnier`: date, place, fee, prizes, bank details, link to last
 *   year's album) and the Advent calendars 2021/2023 (`advent-calendar` with 24 doors each; posters and videos
 *   go to the media library, folders "Adventkalender/<year>").
 *
 * Usage:
 *   node scripts/migrate-pages.js --images <hvtdp/src/assets/images> --videos <hvtdp/src/assets/videos>
 *     [--images-url https://www.hvtdpstainz.at/assets/images] [--videos-url https://www.hvtdpstainz.at/assets/videos]
 *
 * Run the gallery migration first (album link). Safe to re-run: the single type and the calendars (by year)
 * are updated, uploaded files are reused.
 */

const { createCounter, createMediaUploader, parseArgs, runMigration, setPublicPermissions, setSingle, upsert } = require('./lib/migrate-utils');

/** What hallenturnier.component.ts had as TOURNAMENT constant. */
const HALLENTURNIER = {
  title: '17. Stainzer Hallenturnier 2027',
  lead: 'Das größte Hallenturnier für Hobby-, Firmen- und Vereinsmannschaften im Bezirk – anmelden, mitspielen und Spaß haben!',
  image: 'hallenturnier_2027.jpg',
  date: '2027-01-09',
  dateHint: 'Erweiterung auf Fr, 08.01. möglich',
  location: 'Mittelschule Stainz',
  format: '3 + 1',
  entryFee: 70,
  registrationDeadline: '2027-01-05',
  registrationOpen: true,
  prizes: [
    'Urkunde für jede teilnehmende Mannschaft',
    'Pokal und Sachpreise für die besten 8 Mannschaften',
    'Offizielles Siegertrikot für jeden Spieler der Siegermannschaft',
  ],
  bankRecipient: 'HV TDP Stainz',
  iban: 'AT67 3843 9000 0481 3481',
  paymentReference: 'Hallenturnier 2027 + Mannschaftsname',
  lastEditionAlbum: { year: '2026', slug: '16-stainzer-hallenturnier' },
};

/** What advent.component.ts had as SEASON_TEXT. */
const ADVENT = [
  {
    year: '2021',
    title: 'Sport-Adventkalender',
    lead: 'Premiere! Die Weihnachtszeit ist ja die ruhigste des Jahres – wir nutzen sie, um das Fußballjahr Revue passieren zu lassen: Jeden Tag stellen wir euch einen Spieler aus dem Meisterschaftskader vor.',
    note: null,
  },
  {
    year: '2023',
    title: 'Tor-Adventkalender',
    lead: 'Wir lassen das vergangene Fußballjahr mit einer der schönsten Sachen im Fußball Revue passieren: Toren! Mit dem HV TDP „Tor-Adventkalender“ stellen wir euch jeden Tag eines unserer schönsten Tore vor.',
    note: 'Ab Türchen 11 folgen die Tore aus dem Fanvoting zum Tor des Jahres 2023 – in der Reihenfolge des Endergebnisses, bis zum 1. Platz am 24. Dezember.',
  },
];

runMigration(async () => {
  const args = parseArgs(['images', 'videos'], ['images-url', 'videos-url']);
  const images = createMediaUploader({ images: args.images, imagesUrl: args['images-url'] });
  const videos = createMediaUploader({ images: args.videos, imagesUrl: args['videos-url'] });
  const counter = createCounter();

  // Hallenturnier
  const { image, prizes, lastEditionAlbum, ...fields } = HALLENTURNIER;
  const imageFile = await images.get(image, 'Hallenturnier', HALLENTURNIER.title, { folder: 'Hallenturnier' });
  const album = await strapi.documents('api::album.album').findFirst({ filters: lastEditionAlbum });
  if (!album) console.log(`Album ${lastEditionAlbum.year}/${lastEditionAlbum.slug} not found (run the gallery area first) → no link`);
  await setSingle('api::hallenturnier.hallenturnier', {
    ...fields,
    image: imageFile?.id ?? null,
    prizes: prizes.map((text) => ({ text })),
    lastEditionAlbum: album?.documentId ?? null,
  });
  counter.add('hallenturnier', 'updated');

  // Advent calendars
  for (const calendar of ADVENT) {
    const folder = `Adventkalender/${calendar.year}`;
    const doors = [];
    for (let day = 1; day <= 24; day++) {
      const label = `Adventkalender ${calendar.year} Türchen ${day}`;
      const poster = await images.get(`advent/${calendar.year}/${calendar.year}_Adventskalender_${day}.jpg`, label, `${calendar.title} – Türchen ${day}`, { folder });
      const video = await videos.get(`advent/${calendar.year}/${calendar.year}_HV TDP Stainz_Adventskalender_${day}.mp4`, label, `${calendar.title} – Türchen ${day}`, { folder });
      doors.push({ day, poster: poster?.id ?? null, video: video?.id ?? null });
    }
    counter.add('advent-calendar', await upsert('api::advent-calendar.advent-calendar', { year: calendar.year }, { ...calendar, doors }));
  }

  await setPublicPermissions('hallenturnier', ['find']);
  await setPublicPermissions('advent-calendar', ['find', 'findOne']);
  counter.report();
  await images.report();
  await videos.report();
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
