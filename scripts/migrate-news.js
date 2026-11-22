'use strict';

/**
 * Migrates the legacy HV TDP news (getNews.php JSON export) into the
 * `news-item` collection, uploading all referenced images.
 *
 * Usage:
 *   node scripts/migrate-news.js --source <news.json> --images <hvtdp/src/assets/images>
 *     [--images-url https://www.hvtdpstainz.at/assets/images]
 *
 * Images missing from --images are downloaded from --images-url, if given.
 *
 * Safe to re-run: items whose newsId already exists are skipped, and files
 * already in the media library are reused.
 */

const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const mime = require('mime-types');
const sharp = require('sharp');
const domino = require('@mixmark-io/domino');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

const NEWS_UID = 'api::news-item.news-item';

const BLOCK_TAGS = new Set([
  'ARTICLE', 'BLOCKQUOTE', 'DIV', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HR', 'LI', 'OL', 'P', 'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH', 'UL',
]);
const STRUCTURAL_TAGS = new Set(['OL', 'UL', 'TABLE', 'TBODY', 'THEAD', 'TR']);

const stats = {
  created: 0,
  skipped: 0,
  uploaded: 0,
  reused: 0,
  downloaded: 0,
  repaired: [],
  missing: [],
};
const fileCache = new Map();
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvtdp-news-'));

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const source = get('--source');
  const images = get('--images');
  const imagesUrl = get('--images-url');

  if (!source || !images) {
    throw new Error(
      'Usage: node scripts/migrate-news.js --source <news.json> --images <images dir> [--images-url <url>]'
    );
  }

  return {
    source: path.resolve(source),
    images: path.resolve(images),
    imagesUrl: imagesUrl && imagesUrl.replace(/\/$/, ''),
  };
}

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

// Normalizes legacy paths like "news/x.jpg", "news\\x.jpg", "../../assets/images/news/x.jpg"
// to a path relative to the images directory.
function toImagesRelativePath(legacyPath) {
  return legacyPath
    .replace(/\\/g, '/')
    .replace(/^(\.\.\/)+/, '')
    .replace(/^\/?assets\/images\//, '');
}

function getFileData(filePath) {
  const fileName = path.basename(filePath);

  return {
    filepath: filePath,
    originalFilename: fileName,
    size: fs.statSync(filePath).size,
    mimetype: mime.lookup(fileName) || 'application/octet-stream',
  };
}

async function uploadFile(file, name) {
  const [uploaded] = await strapi
    .plugin('upload')
    .service('upload')
    .upload({
      files: file,
      data: {
        fileInfo: {
          alternativeText: name,
          caption: name,
          name,
        },
      },
    });

  return uploaded;
}

async function downloadImage(relativePath, imagesUrl) {
  const url = `${imagesUrl}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetch(url);

  if (!response.ok) {
    return null;
  }

  const filePath = path.join(downloadDir, relativePath);
  await fs.outputFile(filePath, Buffer.from(await response.arrayBuffer()));
  stats.downloaded++;
  return filePath;
}

// Re-encodes a truncated/corrupt image, keeping the part browsers render today.
async function repairImage(filePath, relativePath) {
  const repairedPath = path.join(downloadDir, 'repaired', relativePath);
  await fs.ensureDir(path.dirname(repairedPath));
  await sharp(filePath, { failOn: 'none' }).toFile(repairedPath);
  return repairedPath;
}

// Returns the media library file for a legacy image path, uploading it on first use.
async function getOrUploadImage(legacyPath, { images: imagesDir, imagesUrl }, newsId) {
  if (!legacyPath) {
    return null;
  }

  const relativePath = toImagesRelativePath(legacyPath);

  if (fileCache.has(relativePath)) {
    return fileCache.get(relativePath);
  }

  let filePath = path.join(imagesDir, relativePath);

  if (!fs.existsSync(filePath) && imagesUrl) {
    filePath = await downloadImage(relativePath, imagesUrl);
  }

  if (!filePath || !fs.existsSync(filePath)) {
    stats.missing.push(`${newsId}: ${legacyPath}`);
    return null;
  }

  const name = path.basename(relativePath);
  let file = await strapi.db.query('plugin::upload.file').findOne({ where: { name } });

  if (file) {
    stats.reused++;
  } else {
    try {
      file = await uploadFile(getFileData(filePath), name);
    } catch (error) {
      try {
        file = await uploadFile(getFileData(await repairImage(filePath, relativePath)), name);
        stats.repaired.push(`${newsId}: ${legacyPath}`);
      } catch {
        stats.missing.push(`${newsId}: ${legacyPath} (${error.message})`);
        return null;
      }
    }
    stats.uploaded++;
  }

  fileCache.set(relativePath, file);
  return file;
}

function isLocalImage(src) {
  return src && !/^(https?:|data:|\/\/)/i.test(src);
}

// The legacy site rendered news with `white-space: pre-line`, so raw newlines in
// the HTML are visible line/paragraph breaks. Turn them into <br> before Markdown
// conversion collapses whitespace.
function preserveLineBreaks(document) {
  const walker = document.createTreeWalker(document.body, 4 /* NodeFilter.SHOW_TEXT */);
  const textNodes = [];

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  for (const node of textNodes) {
    const parent = node.parentNode;
    let text = node.data.replace(/\r\n?/g, '\n');

    if (!text.includes('\n') || parent.closest('pre')) {
      continue;
    }

    const isWhitespaceOnly = text.trim() === '';
    const prevIsBlock = !node.previousSibling || BLOCK_TAGS.has(node.previousSibling.nodeName);
    const nextIsBlock = !node.nextSibling || BLOCK_TAGS.has(node.nextSibling.nodeName);

    if (STRUCTURAL_TAGS.has(parent.nodeName) || (isWhitespaceOnly && (prevIsBlock || nextIsBlock))) {
      continue;
    }

    if (prevIsBlock) {
      text = text.replace(/^\s+/, '');
    }
    if (nextIsBlock) {
      text = text.replace(/\s+$/, '');
    }

    const fragment = document.createDocumentFragment();
    const lines = text.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').split('\n');

    lines.forEach((line, index) => {
      if (index > 0) {
        fragment.appendChild(document.createElement('br'));
      }
      if (line) {
        fragment.appendChild(document.createTextNode(line));
      }
    });

    parent.replaceChild(fragment, node);
  }
}

function createTurndown() {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  turndown.use(gfm);
  return turndown;
}

function plainTextToMarkdown(text, turndown) {
  return text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => turndown.escape(line.trim()))
        .join('  \n')
    )
    .join('\n\n');
}

async function htmlToMarkdown(html, item, options, turndown) {
  const document = domino.createDocument(`<!doctype html><html><body>${html}</body></html>`);

  for (const img of Array.from(document.querySelectorAll('img'))) {
    const src = img.getAttribute('src');

    if (isLocalImage(src)) {
      const file = await getOrUploadImage(src, options, item.newsId);
      if (file) {
        img.setAttribute('src', file.url);
      }
    }

    // Some legacy posts carry Angular template bindings as alt text.
    if (!img.getAttribute('alt') || img.getAttribute('alt').includes('{{')) {
      img.setAttribute('alt', item.title);
    }
  }

  preserveLineBreaks(document);

  return turndown
    .turndown(document.body)
    // Consecutive hard breaks are a paragraph break.
    .replace(/ {2}\n(?:[ \t]*\n)+/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function buildContent(item, options, turndown) {
  if (item.htmlNews && item.htmlNews.trim()) {
    return htmlToMarkdown(item.htmlNews, item, options, turndown);
  }

  return plainTextToMarkdown(item.news || '', turndown);
}

async function migrateItem(item, options, turndown) {
  const newsId = Number(item.newsId);
  const existing = await strapi.documents(NEWS_UID).findFirst({ filters: { newsId } });

  if (existing) {
    stats.skipped++;
    return;
  }

  const image = await getOrUploadImage(item.imagePath, options, newsId);
  const homeImage = await getOrUploadImage(item.imagePathHome, options, newsId);
  const content = await buildContent(item, options, turndown);

  await strapi.documents(NEWS_UID).create({
    status: 'published',
    data: {
      newsId,
      date: item.newsDate,
      title: item.title.trim(),
      content,
      image: image ? image.id : null,
      homeImage: homeImage ? homeImage.id : null,
    },
  });

  stats.created++;
}

async function migrateNews(options) {
  const news = await fs.readJson(options.source);
  const turndown = createTurndown();

  // Oldest first, so the media library and admin list read chronologically.
  news.sort((a, b) => Number(a.newsId) - Number(b.newsId));

  for (const item of news) {
    try {
      await migrateItem(item, options, turndown);
    } catch (error) {
      console.error(`Failed to migrate news ${item.newsId}:`, error.message);
    }
  }

  await setPublicPermissions('news-item', ['find', 'findOne']);

  console.log(`Created: ${stats.created}, skipped (already present): ${stats.skipped}`);
  console.log(
    `Files uploaded: ${stats.uploaded} (downloaded: ${stats.downloaded}), reused: ${stats.reused}`
  );

  if (stats.repaired.length) {
    console.log(`Repaired corrupt images (${stats.repaired.length}):`);
    stats.repaired.forEach((entry) => console.log(`  ${entry}`));
  }

  if (stats.missing.length) {
    console.log(`Missing images (${stats.missing.length}):`);
    stats.missing.forEach((entry) => console.log(`  ${entry}`));
  }
}

async function main() {
  const options = parseArgs();
  const { createStrapi, compileStrapi } = require('@strapi/strapi');

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();

  app.log.level = 'error';

  await migrateNews(options);
  await fs.remove(downloadDir);
  await app.destroy();

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
