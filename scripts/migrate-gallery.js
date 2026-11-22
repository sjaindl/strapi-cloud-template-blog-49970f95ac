'use strict';

/**
 * Migrates the photo gallery (getPhotos.php JSON export) into `album`: name, year, date and the photos in the
 * media library (one folder per album, "Galerie/<year>/<album>"), in the legacy order. The first photo is the
 * cover. Slugs are computed like the website did, so existing album links keep working.
 *
 * Usage:
 *   node scripts/migrate-gallery.js --exports <dir with getPhotos.json> --images <hvtdp/src/assets/images>
 *     [--images-url https://www.hvtdpstainz.at/assets/images]
 *
 * Albums without any photo file are skipped (re-run once the files exist). Safe to re-run: albums are matched
 * by year and slug, uploaded files are reused.
 */

const fs = require('fs');
const path = require('path');
const { createCounter, createMediaUploader, parseArgs, readSource, runMigration, setPublicPermissions, upsert } = require('./lib/migrate-utils');

/** Photo folders that exist on disk but were never entered as an album. Same shape as the legacy export. */
const EXTRA_ALBUMS = [{ season: '2022', name: 'Weihnachtsfeier 2022', date: '2022-12-01', folder: 'gallery/weihnachtsfeier2022' }];

/** Album folders that were uploaded into another album's folder by mistake: legacy folder → real folder. */
const FOLDER_FIXES = {
  'gallery/bilder14_hallenturnier': 'gallery/ausflug_aut_cro/bilder14_hallenturnier',
  'gallery/5_fruehlingskegelturnier': 'gallery/fotoscomedyhirten/5_fruehlingskegelturnier',
};
const fixFolder = (imagePath) => {
  const folder = Object.keys(FOLDER_FIXES).find((legacy) => imagePath.startsWith(`${legacy}/`));
  return folder ? FOLDER_FIXES[folder] + imagePath.slice(folder.length) : imagePath;
};

/** Same rule as the website's album links: characters other than a-z/0-9 become "-". */
const albumSlug = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'album';

runMigration(async () => {
  const args = parseArgs(['exports', 'images'], ['images-url']);
  const legacy = await readSource(path.join(args.exports, 'getPhotos.json'));
  const media = createMediaUploader({ images: args.images, imagesUrl: args['images-url'] });
  const counter = createCounter();
  const skipped = [];

  const extras = EXTRA_ALBUMS.filter((extra) => !legacy.some((album) => album.season === extra.season && album.name === extra.name)).map(
    ({ folder, ...album }) => ({
      ...album,
      photos: fs
        .readdirSync(path.join(args.images, folder))
        .filter((file) => /\.(jpe?g|png|gif|webp)$/i.test(file))
        .sort()
        .map((file) => ({ description: '', imagePath: `${folder}/${file}` })),
    })
  );

  for (const album of [...legacy, ...extras]) {
    const name = album.name.trim();
    const year = String(album.season).trim();
    const slug = albumSlug(name);
    const folder = `Galerie/${year}/${name.replace(/\//g, '-')}`;
    const photos = [];
    for (const photo of album.photos) {
      const caption = (photo.description || '').trim() || name;
      const file = await media.get(fixFolder(photo.imagePath), `album ${year} ${name}`, caption, { folder });
      if (file) photos.push(file.id);
    }
    if (!photos.length) {
      skipped.push(`${year} ${name} (${album.photos.length} photos missing)`);
      continue;
    }
    counter.add(
      'album',
      await upsert('api::album.album', { year, slug }, { name, slug, year, date: album.date || null, cover: photos[0], photos })
    );
  }

  await setPublicPermissions('album', ['find', 'findOne']);
  counter.report();
  await media.report();
  if (skipped.length) {
    console.log(`Albums skipped, no photo file found (${skipped.length}):`);
    skipped.forEach((line) => console.log(`  ${line}`));
  }
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
