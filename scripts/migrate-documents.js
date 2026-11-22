'use strict';

/**
 * Migrates the documents (getDocuments.php JSON export) into `document`: title and date split from the
 * legacy description ("2018-01-30, Sitzungsprotokoll"), a category instead of the keyword grouping the
 * website used, the protected flag, and the PDF in the media library.
 *
 * Usage:
 *   node scripts/migrate-documents.js --exports <dir with getDocuments.json> --documents <hvtdp/src/assets/documents>
 *     [--documents-url https://www.hvtdpstainz.at/assets/documents]
 *
 * Safe to re-run: documents are matched by title and date and updated.
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

const UID = 'api::document.document';

/**
 * PDFs that exist in the documents folder but were never listed by the PHP API.
 * Same shape as the legacy export.
 */
const EXTRA_DOCUMENTS = [
  {
    link: 'Sitzungsprotokoll_2023_02_24-10_Jahresfeier.pdf',
    protected: '1',
    description: '2023-02-24, Sitzungsprotokoll 10-Jahresfeier',
  },
];

/** Stable key from the file name, e.g. "beitrittserklaerung.pdf" → "beitrittserklaerung"; links fixed documents to the website. */
const slugOf = (link) =>
  link
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Same rules the website used for its keyword grouping. */
const categoryOf = (title) =>
  /Endergebnis/i.test(title) ? 'Turnierergebnisse' : /Protokoll|Stellungnahme/i.test(title) ? 'Protokolle' : 'Allgemein';

runMigration(async () => {
  const args = parseArgs(['exports', 'documents'], ['documents-url']);
  const listed = await readSource(path.join(args.exports, 'getDocuments.json'));
  const documents = [...listed, ...EXTRA_DOCUMENTS.filter((extra) => !listed.some((doc) => doc.link === extra.link))];
  const files = createMediaUploader({ images: args.documents, imagesUrl: args['documents-url'] });
  const counter = createCounter();

  for (const [index, document] of documents.entries()) {
    const match = /^(\d{4}-\d{2}-\d{2}),\s*(.*)$/.exec(document.description.trim());
    const title = (match ? match[2] : document.description).trim();
    const file = await files.get(document.link, `document ${title}`, title);
    if (!file) {
      continue; // reported as missing; the website cannot offer a document without its file
    }
    const result = await upsert(
      UID,
      // Titles repeat (several "Sitzungsprotokoll"), title + date is unique.
      { title, date: match ? match[1] : { $null: true } },
      {
        title,
        slug: slugOf(document.link),
        date: match ? match[1] : null,
        category: categoryOf(title),
        file: file.id,
        protected: String(document.protected) !== '0',
        order: index + 1,
      }
    );
    counter.add('document', result);
  }

  await setPublicPermissions('document', ['find', 'findOne']);
  counter.report();
  await files.report();
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
