'use strict';

/**
 * Migrates the event pages the website had in code (Bocciaturnier, Kleinfeldturnier, Big Darts, Entenrennen) into
 * `club-event` entries: texts as Markdown, date, place, fee or price per duck, bank details and the picture. All
 * are switched off (their last editions are over); switch an event on for its next edition in the admin.
 *
 * Usage: node scripts/migrate-events.js --images <hvtdp/src/assets/images> [--images-url https://www.hvtdpstainz.at/assets/images]
 *
 * Safe to re-run: events are matched by slug. Only fields of the migrated texts are written, so an event that was
 * already switched on or updated in the admin is skipped (use --force true to overwrite).
 */

const { createCounter, createMediaUploader, parseArgs, runMigration, setPublicPermissions, upsert } = require('./lib/migrate-utils');

const BANK = { bankRecipient: 'HV TDP Stainz', iban: 'AT67 3843 9000 0481 3481', bic: 'RZSTAT2G439' };

/** What the old pages (boccia, kleinfeldturnier, bigdarts, duckrun components) showed. */
const EVENTS = [
  {
    slug: 'bocciaturnier',
    title: '4. Bocciaturnier 2026',
    lead: 'Wir bringen auch heuer wieder das Kultspiel aus Italien nach Stainz!',
    image: 'boccia_2026.jpeg',
    date: '2026-08-22',
    startTime: '12:30:00.000',
    location: 'Stadion Stainz',
    format: '2 Spieler',
    formType: 'team',
    paymentReference: 'Boccia 2026 + Mannschaftsname',
    description: [
      'Sichert euch euren Platz und meldet euch an – wir freuen uns auf euch! Für jeden Spieler gibt es am Turniertag ein **Freigetränk**.',
      'Erst mit der Einzahlung des Nenngeldes ist die Anmeldung fixiert.',
    ].join('\n\n'),
  },
  {
    slug: 'kleinfeldturnier',
    title: 'Stainzer Kleinfeldturnier 2023',
    lead: 'Das Stainzer Kleinfeldturnier für Hobby-, Firmen- und Vereinsmannschaften!',
    image: 'turnier_2023.jpeg',
    date: '2023-07-22',
    startTime: '10:00:00.000',
    location: 'Helvetia Versicherungen Stadion Stainz',
    format: '5 + 1',
    formType: 'team',
    phoneRequired: true,
    paymentReference: 'Kleinfeldturnier 2023 + Mannschaftsname',
    description: [
      '🍻 Auch heuer gibt es wieder eine **Schankwertung**!',
      'Achtung: begrenzte Teilnehmerzahl – die Anmeldung ist erst mit dem Einzahlen des Nenngeldes fixiert.',
      'Weitere Infos: [Stainzer Kleinfeldturnier auf Facebook](https://www.facebook.com/events/911818543233169/)',
    ].join('\n\n'),
  },
  {
    slug: 'bigdarts',
    title: 'Big Darts Turnier 2025',
    lead: 'Fußball ⚽ und Darts 🎯 in einem geht nicht? Geht doch!',
    image: 'bigdarts.jpg',
    date: '2025-05-31',
    startTime: '13:00:00.000',
    location: 'Freibad Stainz',
    format: '2er Teams',
    formType: 'team',
    price: 20,
    paymentReference: 'Big Darts 2025 + Mannschaftsname',
    description: [
      'Wir bringen das Kultspiel aus dem Ally Pally in einer etwas anderen und vor allem „größeren“ Form nach Stainz! Das Big Darts Fußballturnier findet am Gelände des brandneuen Freibades in Stainz statt. 🏝⚽️😎',
      'Gespielt wird in 2er Teams. Das Turnier ist für jeden etwas – egal ob Fußballer/in oder nicht, egal ob jung oder alt, jeder und jede ist herzlich willkommen! Sucht euch einen Partner oder eine Partnerin und spielt mit um den Turniersieg. Für die besten Mannschaften gibt es tolle Preise! 🎁',
      'Achtung: begrenzte Teilnehmeranzahl.',
    ].join('\n\n'),
  },
  {
    slug: 'entenrennen',
    title: '3. Entenrennen Stainz 2025',
    lead: 'Kauf deine Enten und gewinn tolle Preise beim 3. Entenrennen des HV TDP Stainz!',
    image: 'duckrun_2025.jpeg',
    date: '2025-09-20',
    startTime: '17:30:00.000',
    location: 'Stainz',
    formType: 'order',
    price: 3,
    orderUnit: 'Ente',
    orderUnitPlural: 'Enten',
    paymentReference: 'Entenrennen 2025 + Name',
    description: [
      '### Preise',
      '🥇 500 Euro  \n🥈 300 Euro  \n🥉 150 Euro  \n🎁 und viele weitere Sachpreise',
      '### Kaufmöglichkeiten',
      '- bei Spielern und Heimspielen des HV TDP Stainz\n- direkt hier auf unserer Homepage\n- telefonisch unter 0664/43 10 021\n- bei der Trafik Schauer',
      '### Wichtig',
      'Keine Anwesenheitspflicht: Die Gewinner werden nach der Veranstaltung auf unserer Homepage bekannt gegeben. Bei Gewinn bitte bei uns melden, damit wir den Gewinn aushändigen können.',
    ].join('\n\n'),
  },
];

runMigration(async () => {
  const args = parseArgs(['images'], ['images-url', 'force']);
  const media = createMediaUploader({ images: args.images, imagesUrl: args['images-url'] });
  const counter = createCounter();

  for (const { image, ...event } of EVENTS) {
    const existing = await strapi.documents('api::club-event.club-event').findFirst({ filters: { slug: event.slug } });
    if (existing?.active && args.force !== 'true') {
      console.log(`${event.slug}: active in the admin → kept (use --force true to overwrite)`);
      continue;
    }
    const file = await media.get(image, `event ${event.slug}`, event.title, { folder: 'Veranstaltungen' });
    counter.add(
      'club-event',
      await upsert('api::club-event.club-event', { slug: event.slug }, { ...BANK, ...event, active: false, registrationOpen: false, image: file?.id ?? null })
    );
  }

  await setPublicPermissions('club-event', ['find', 'findOne']);
  counter.report();
  await media.report();
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
