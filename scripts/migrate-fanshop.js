'use strict';

/**
 * Migrates the fanshop (getItems.php JSON export) into `shop-item`: real prices instead of price texts,
 * cleaned descriptions, images in the media library, and order options (sizes, variants, text fields)
 * from the table below — the legacy data only had them as free text. After the migration the options
 * are maintained in the Strapi admin.
 *
 * Usage:
 *   node scripts/migrate-fanshop.js --exports <dir with getItems.json> --images <hvtdp/src/assets/images>
 *     [--images-url https://www.hvtdpstainz.at/assets/images]
 *
 * Safe to re-run: items are matched by name and updated (including their options).
 */

const path = require('path');
const {
  createCounter,
  createMediaUploader,
  parseArgs,
  readSource,
  runMigration,
  setPublicPermissions,
  upsert,
} = require('./lib/migrate-utils');

const UID = 'api::shop-item.shop-item';
const CATEGORIES = ['Bekleidung', 'Accessoires', 'Sonstiges'];

const choice = (label, price = null) => ({ label, price });
const select = (label, choices, { required = true } = {}) => ({ label, kind: 'Auswahl', required, placeholder: null, choices });
const text = (label, placeholder, { required = true } = {}) => ({ label, kind: 'Text', required, placeholder, choices: [] });

const shirtCut = select('Schnitt', [choice('Herren'), choice('Damen')]);
const shirtSize = text('Größe', 'z. B. M');
const shirtWithShorts = select('Umfang', [choice('Trikot', 35), choice('Trikot + Hose', 55)]);
const nameNumber = text('Name / Nummer', 'optional, für die Rückseite', { required: false });
const capOptions = [text('Farbe', 'z. B. Schwarz'), text('Initialen / Text', 'optional, wird gestickt', { required: false })];

/** Order options per item name (seed data, derived from the legacy price texts and descriptions). */
const OPTIONS = {
  Kapperl: [select('Ausführung', [choice('Ohne Logo', 21), choice('Mit Logo', 25)]), select('Größe', [choice('S/M'), choice('L/XL')])],
  Weihnachtsmütze: [select('Farbe', [choice('Rot'), choice('Violett'), choice('Blau')])],
  'HV TDP Vereinssocken': [select('Größe', [choice('36–41'), choice('42–46')])],
  'Hoodie & Hose': [
    select('Ausführung', [choice('Herren', 49.9), choice('Damen', 49.9), choice('Kinder', 29.9)]),
    text('Größe', 'z. B. M oder 140'),
  ],
  'Winterhaube Herren': capOptions,
  'Winterhaube Damen': capOptions,
  Schlapfn: [
    select('Ausführung', [choice('Ohne Initialen', 27.5), choice('Mit Initialen', 32.5)]),
    text('Initialen', 'nur bei „Mit Initialen“', { required: false }),
  ],
  'Trikot - 10 Jahre Sonderedition (grau)': [shirtWithShorts, shirtCut, shirtSize],
  'Trikot - Spiel gegen die FK Austria Wien Allstars (weiß, magenta)': [shirtWithShorts, shirtCut, shirtSize],
  'Trikot (dunkelblau)': [shirtWithShorts, shirtCut, shirtSize],
  'Trikot - 5 Jahre Sonderedition (rot)': [shirtCut, shirtSize],
  'Trikot (Grau, Magenta)': [shirtCut, shirtSize, nameNumber],
  'Trikot - Spiel gegen FC Red Bull Salzburg (dunkelblau, magenta)': [shirtCut, shirtSize, nameNumber],
  'Trikot - Meister Edition 2017/2018': [shirtCut, shirtSize],
  'Trikot - Vereinsgründung (weiß, magenta)': [shirtCut, shirtSize, nameNumber],
  Handtuch: [select('Größe', [choice('Klein', 12.9), choice('Groß', 17.9)])],
  Kaffeetasse: [text('Farbe', 'z. B. Magenta')],
  Gutschein: [text('Betrag', 'z. B. 30 €')],
};

/** Shown instead of a price (items without a price). */
const PRICE_NOTES = { Gutschein: 'Betrag frei wählbar' };

/** First amount in a legacy price text: "€ 14,50" → 14.5, "21,00 €, mit Logo: 25,00 €" → 21. */
const parsePrice = (value) => {
  const match = /(\d+)(?:,(\d{1,2}))?/.exec(value || '');
  return match ? Number(`${match[1]}.${(match[2] || '0').padEnd(2, '0')}`) : null;
};

/** Hard-wrapped legacy text: line breaks inside a paragraph become spaces, blank lines stay paragraphs. */
const cleanDescription = (value) =>
  (value || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split('\n').map((line) => line.trim()).filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n\n');

runMigration(async () => {
  const args = parseArgs(['exports', 'images'], ['images-url']);
  const items = await readSource(path.join(args.exports, 'getItems.json'));
  const media = createMediaUploader({ images: args.images, imagesUrl: args['images-url'] });
  const counter = createCounter();
  const unmapped = [];

  for (const [index, item] of items.entries()) {
    const name = item.name.trim();
    const optionGroups = OPTIONS[name] ?? [];
    if (!OPTIONS[name] && (item.price || '').match(/\d+,\d{2}/g)?.length > 1) {
      unmapped.push(`${name} (${item.price})`);
    }
    const choicePrices = optionGroups.flatMap((group) => group.choices.map((c) => c.price)).filter((p) => p !== null);
    const image = await media.get(item.imagePath, `shop-item ${name}`, name);

    const result = await upsert(
      UID,
      { name },
      {
        name,
        description: cleanDescription(item.description),
        category: CATEGORIES.includes(item.category) ? item.category : 'Sonstiges',
        image: image ? image.id : null,
        // With priced choices the cheapest one is the base price ("ab …").
        price: choicePrices.length ? Math.min(...choicePrices) : parsePrice(item.price),
        priceNote: PRICE_NOTES[name] ?? null,
        order: index + 1,
        optionGroups,
      }
    );
    counter.add('shop-item', result);
  }

  await setPublicPermissions('shop-item', ['find', 'findOne']);
  counter.report();
  if (unmapped.length) {
    console.log(`Items with several prices but no options in the table (check in the admin):`);
    unmapped.forEach((entry) => console.log(`  ${entry}`));
  }
  await media.report();
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
