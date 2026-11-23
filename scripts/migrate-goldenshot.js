'use strict';

/**
 * Migrates the Torschuss Challenge (Golden Shot) into Strapi: the page texts the website had in code (single type
 * `golden-shot`, switched off, the 2026 edition is over) and the 2026 voting (`poll` of type goldenShot with the
 * participants as options and their votes). Contact data is not migrated: the public PHP export no longer
 * contains it, and that edition is over.
 *
 * Usage: node scripts/migrate-goldenshot.js --exports <dir with getGoldenShot.json> --images <hvtdp/src/assets/images>
 *   [--images-url https://www.hvtdpstainz.at/assets/images]
 *
 * Safe to re-run: page, poll (type + year) and options (poll + name) are updated, files reused.
 */

const path = require('path');
const { createCounter, createMediaUploader, parseArgs, readSource, runMigration, setPublicPermissions, setSingle, upsert } = require('./lib/migrate-utils');

const YEAR = '2026';

/** What the old registration and voting pages showed (goldenshot*.component.html). */
const PAGE = {
  active: false,
  title: 'Torschuss Challenge 2026',
  sponsor: 'powered by 11teamsports Graz',
  image: 'torschusschallenge.jpeg',
  resultImage: 'goldenshot_voting_2026_result.jpeg',
  finalDate: '2026-06-06',
  registrationOpen: false,
  description: [
    'Du traust dir zu, den Ball von der Mittellinie direkt (ohne Berührung vor der Torlinie) ins Tor zu treffen, und willst dabei auch noch einen sensationellen Preis gewinnen? Dann bist du hier genau richtig! Die Anmeldung ist für jede und jeden offen und völlig **kostenlos**.',
    '**Wann:** Samstag, 06. Juni 2026 (in der Halbzeitpause vom Legendenspiel der SK Rapid Allstars)  \n**Wo:** Stadion Stainz',
    '### Was gibt es zu gewinnen?',
    'Der Gewinner erhält **2 VIP-Karten für ein Heimspiel des SK Puntigamer Sturm Graz** (gesponsert von 11teamsports Graz). Die 3 Finalisten erhalten für ihre Teilnahme **gratis Eintritt** zu unserem Sommerfest.',
    '### Wer kann teilnehmen?',
    'Jede und jeder, der mindestens 18 Jahre alt ist.',
    '### Wie läuft der Bewerb ab?',
    '1. Anmeldung über unser Online-Formular (kostenlos)\n2. Online-Voting auf unserer Homepage\n3. Die Top 3 des Votings ziehen ins Finale ein und spielen am Tag des Stadionfests um den Hauptpreis',
  ].join('\n\n'),
};

runMigration(async () => {
  const args = parseArgs(['exports', 'images'], ['images-url']);
  const participants = await readSource(path.join(args.exports, 'getGoldenShot.json'));
  const media = createMediaUploader({ images: args.images, imagesUrl: args['images-url'] });
  const counter = createCounter();

  // Voting 2026 with the participants (alphabetical like the old page) and their votes.
  counter.add('poll', await upsert('api::poll.poll', { type: 'goldenShot', year: YEAR }, { type: 'goldenShot', year: YEAR, open: false, closesAt: '2026-05-17T21:55:00.000Z' }));
  const poll = await strapi.documents('api::poll.poll').findFirst({ filters: { type: 'goldenShot', year: YEAR } });
  const sorted = [...participants].sort((a, b) => a.lastName.localeCompare(b.lastName, 'de') || a.firstName.localeCompare(b.firstName, 'de'));
  for (const participant of sorted) {
    const name = `${participant.firstName.trim()} ${participant.lastName.trim()}`;
    const image = participant.photo ? await media.get(`goldenshot/${participant.photo}`, `participant ${name}`, name, { folder: 'Torschuss Challenge' }) : null;
    counter.add(
      'poll option',
      await upsert(
        'api::poll-option.poll-option',
        { poll: { documentId: poll.documentId }, name },
        { poll: poll.documentId, name, image: image?.id ?? null, votes: parseInt(participant.votes, 10) || 0 }
      )
    );
  }

  const { image, resultImage, ...fields } = PAGE;
  const imageFile = await media.get(image, 'Torschuss Challenge', PAGE.title, { folder: 'Torschuss Challenge' });
  const resultFile = await media.get(resultImage, 'Torschuss Challenge result', `Ergebnis ${PAGE.title}`, { folder: 'Torschuss Challenge' });
  await setSingle('api::golden-shot.golden-shot', { ...fields, image: imageFile?.id ?? null, resultImage: resultFile?.id ?? null, poll: poll.documentId });
  counter.add('golden-shot', 'updated');

  await setPublicPermissions('golden-shot', ['find']);
  counter.report();
  await media.report();
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
