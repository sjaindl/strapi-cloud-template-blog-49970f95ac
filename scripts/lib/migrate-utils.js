'use strict';

/**
 * Shared helpers for the scripts that migrate the legacy HV TDP data (PHP/MySQL JSON exports and
 * images from hvtdp/src/assets/images) into Strapi. Every migration is safe to re-run.
 */

const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const mime = require('mime-types');
const sharp = require('sharp');

/** Reads `--name value` arguments; names listed in `required` must be present. */
function parseArgs(required = [], optional = []) {
  const args = process.argv.slice(2);
  const get = (name) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const result = {};
  for (const name of [...required, ...optional]) {
    result[name] = get(name);
  }
  const missing = required.filter((name) => !result[name]);
  if (missing.length) {
    const usage = [...required.map((n) => `--${n} <${n}>`), ...optional.map((n) => `[--${n} <${n}>]`)];
    throw new Error(`Missing ${missing.map((n) => `--${n}`).join(', ')}. Usage: ${usage.join(' ')}`);
  }
  return result;
}

/** Boots Strapi without the HTTP server, runs `migrate(strapi)` and shuts down again. */
async function runMigration(migrate) {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    await migrate(app);
  } finally {
    await app.destroy();
  }
}

/** Grants the public role the given actions (e.g. find, findOne) on a content type. */
async function setPublicPermissions(controller, actions) {
  const publicRole = await strapi.db.query('plugin::users-permissions.role').findOne({
    where: { type: 'public' },
  });

  for (const action of actions) {
    const fullAction = `api::${controller}.${controller}.${action}`;
    const existing = await strapi.db.query('plugin::users-permissions.permission').findOne({
      where: { action: fullAction, role: publicRole.id },
    });

    if (!existing) {
      await strapi.db.query('plugin::users-permissions.permission').create({
        data: { action: fullAction, role: publicRole.id },
      });
    }
  }
}

/** Reads a JSON export (array) of a legacy PHP endpoint. */
async function readSource(file) {
  const data = await fs.readJson(path.resolve(file));
  if (!Array.isArray(data)) {
    throw new Error(`${file} is not a JSON array`);
  }
  return data;
}

/**
 * Creates the entry if no entry matches `filters`, otherwise updates it with `data`.
 * Returns 'created' or 'updated'.
 */
async function upsert(uid, filters, data, { publish = true } = {}) {
  const existing = await strapi.documents(uid).findFirst({ filters, status: publish ? 'published' : undefined });
  if (existing) {
    await strapi.documents(uid).update({
      documentId: existing.documentId,
      data,
      ...(publish ? { status: 'published' } : {}),
    });
    return 'updated';
  }
  await strapi.documents(uid).create({ data, ...(publish ? { status: 'published' } : {}) });
  return 'created';
}

/** Sets the data of a single type (creates it on first run). */
async function setSingle(uid, data, { publish = true } = {}) {
  const existing = await strapi.documents(uid).findFirst();
  if (existing) {
    await strapi.documents(uid).update({ documentId: existing.documentId, data, ...(publish ? { status: 'published' } : {}) });
  } else {
    await strapi.documents(uid).create({ data, ...(publish ? { status: 'published' } : {}) });
  }
}

/** Normalizes legacy paths like "news/x.jpg", "news\\x.jpg", "../../assets/images/news/x.jpg". */
function toImagesRelativePath(legacyPath) {
  return legacyPath
    .replace(/\\/g, '/')
    .trim()
    .replace(/^(\.\.\/)+/, '')
    .replace(/^\/?assets\/images\//, '');
}

/**
 * Uploads legacy images to the media library, once per file: files already present (same name and
 * folder path) are reused. Missing local files are downloaded from `imagesUrl` if given; truncated
 * or corrupt images are re-encoded.
 */
function createMediaUploader({ images, imagesUrl }) {
  const imagesDir = path.resolve(images);
  const baseUrl = imagesUrl && imagesUrl.replace(/\/$/, '');
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvtdp-media-'));
  const cache = new Map();
  const stats = { uploaded: 0, reused: 0, downloaded: 0, repaired: [], missing: [] };

  const fileData = (filePath, name) => ({
    filepath: filePath,
    originalFilename: name,
    size: fs.statSync(filePath).size,
    mimetype: mime.lookup(name) || 'application/octet-stream',
  });

  const upload = async (filePath, name, caption, folder) => {
    const [uploaded] = await strapi
      .plugin('upload')
      .service('upload')
      .upload({
        files: fileData(filePath, name),
        data: { fileInfo: { alternativeText: caption || name, caption: caption || name, name, ...(folder ? { folder } : {}) } },
      });
    return uploaded;
  };

  /** Id of the media library folder "A/B/C" (created on first use). */
  const folderIds = new Map();
  const folderId = async (folderPath) => {
    if (!folderPath) return null;
    if (folderIds.has(folderPath)) return folderIds.get(folderPath);
    let parent = null;
    for (const name of folderPath.split('/')) {
      const existing = await strapi.db.query('plugin::upload.folder').findOne({
        where: { name, parent: parent ? { id: parent } : { id: { $null: true } } },
      });
      parent = (existing ?? (await strapi.plugin('upload').service('folder').create({ name, parent }))).id;
    }
    folderIds.set(folderPath, parent);
    return parent;
  };

  const download = async (relativePath) => {
    if (!baseUrl) {
      return null;
    }
    const response = await fetch(`${baseUrl}/${relativePath.split('/').map(encodeURIComponent).join('/')}`);
    if (!response.ok) {
      return null;
    }
    const filePath = path.join(downloadDir, relativePath);
    await fs.outputFile(filePath, Buffer.from(await response.arrayBuffer()));
    stats.downloaded++;
    return filePath;
  };

  const repair = async (filePath, relativePath) => {
    const repairedPath = path.join(downloadDir, 'repaired', relativePath);
    await fs.ensureDir(path.dirname(repairedPath));
    await sharp(filePath, { failOn: 'none' }).toFile(repairedPath);
    return repairedPath;
  };

  /**
   * Returns the media file for a legacy path (uploading it on first use) or null if it does not exist.
   * `label` identifies the entry in the "missing" report; `caption` becomes alt text and caption.
   * Files are named after their legacy relative path with "/" (and other characters Strapi does not allow)
   * replaced by "_", e.g. "gallery_boccia_2026_01.jpg", which keeps generic names like "01.jpg" apart.
   * `folder` ("Galerie/2026/Boccia") puts new uploads into that media library folder.
   */
  async function get(legacyPath, label, caption, { folder } = {}) {
    if (!legacyPath || !legacyPath.trim()) {
      return null;
    }
    const relativePath = toImagesRelativePath(legacyPath);
    if (cache.has(relativePath)) {
      return cache.get(relativePath);
    }

    let filePath = path.join(imagesDir, relativePath);
    if (!fs.existsSync(filePath)) {
      filePath = await download(relativePath);
    }
    if (!filePath || !fs.existsSync(filePath)) {
      stats.missing.push(`${label}: ${legacyPath}`);
      cache.set(relativePath, null);
      return null;
    }

    // Characters Strapi rejects in file names ("99*100.JPG") become "_" as well.
    const name = relativePath.replace(/[\\/:*?"<>|]/g, '_');
    let file = await strapi.db.query('plugin::upload.file').findOne({ where: { name } });
    if (file) {
      stats.reused++;
    } else {
      try {
        file = await upload(filePath, name, caption, await folderId(folder));
      } catch (error) {
        try {
          file = await upload(await repair(filePath, relativePath), name, caption, await folderId(folder));
          stats.repaired.push(`${label}: ${legacyPath}`);
        } catch {
          stats.missing.push(`${label}: ${legacyPath} (${error.message})`);
          cache.set(relativePath, null);
          return null;
        }
      }
      stats.uploaded++;
    }
    cache.set(relativePath, file);
    return file;
  }

  async function report() {
    console.log(`Files uploaded: ${stats.uploaded} (downloaded: ${stats.downloaded}), reused: ${stats.reused}`);
    if (stats.repaired.length) {
      console.log(`Repaired corrupt images (${stats.repaired.length}):`);
      stats.repaired.forEach((entry) => console.log(`  ${entry}`));
    }
    if (stats.missing.length) {
      console.log(`Missing images (${stats.missing.length}):`);
      stats.missing.forEach((entry) => console.log(`  ${entry}`));
    }
    await fs.remove(downloadDir);
  }

  return { get, report, stats };
}

/** Counts created/updated entries per content type and prints them. */
function createCounter() {
  const counts = {};
  return {
    add(type, result) {
      counts[type] ??= { created: 0, updated: 0 };
      counts[type][result]++;
    },
    report() {
      for (const [type, { created, updated }] of Object.entries(counts)) {
        console.log(`${type}: ${created} created, ${updated} updated`);
      }
    },
  };
}

module.exports = {
  parseArgs,
  runMigration,
  setPublicPermissions,
  readSource,
  upsert,
  setSingle,
  toImagesRelativePath,
  createMediaUploader,
  createCounter,
};
