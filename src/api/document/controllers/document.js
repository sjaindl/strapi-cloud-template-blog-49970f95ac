'use strict';

/**
 * document controller.
 *
 * Protected documents (minutes, statutes) are only handed out after the members' password was checked:
 * the public list never contains their file, and `download` streams the PDF only with the right password
 * (DOCUMENTS_PASSWORD in the server's .env). Failed attempts are limited per IP address.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createCoreController } = require('@strapi/strapi').factories;

const UID = 'api::document.document';
const MAX_FAILED_ATTEMPTS = 10;
const BLOCK_MS = 15 * 60 * 1000;
const failedAttempts = new Map(); // ip → { count, resetAt }

const hideProtectedFile = (document) => (document && document.protected ? { ...document, file: null } : document);

/** Constant-time comparison (on hashes, so different lengths do not leak either). */
const passwordMatches = (password) => {
  const expected = process.env.DOCUMENTS_PASSWORD;
  if (!expected || typeof password !== 'string') {
    return false;
  }
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(password), digest(expected));
};

const isBlocked = (ip) => {
  const entry = failedAttempts.get(ip);
  if (entry && entry.resetAt < Date.now()) {
    failedAttempts.delete(ip);
    return false;
  }
  return Boolean(entry && entry.count >= MAX_FAILED_ATTEMPTS);
};

const recordFailure = (ip) => {
  const entry = failedAttempts.get(ip) ?? { count: 0, resetAt: Date.now() + BLOCK_MS };
  entry.count++;
  failedAttempts.set(ip, entry);
};

module.exports = createCoreController(UID, ({ strapi }) => ({
  async find(ctx) {
    const response = await super.find(ctx);
    return { ...response, data: response.data.map(hideProtectedFile) };
  },

  async findOne(ctx) {
    const response = await super.findOne(ctx);
    return response ? { ...response, data: hideProtectedFile(response.data) } : response;
  },

  /** POST /api/documents/:documentId/download { password } → the PDF. */
  async download(ctx) {
    const ip = ctx.request.ip;
    if (isBlocked(ip)) {
      return ctx.tooManyRequests('Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.');
    }

    const document = await strapi.documents(UID).findOne({
      documentId: ctx.params.documentId,
      populate: ['file'],
    });
    if (!document || !document.file) {
      return ctx.notFound('Dokument nicht gefunden.');
    }

    if (document.protected) {
      if (!process.env.DOCUMENTS_PASSWORD) {
        strapi.log.error('DOCUMENTS_PASSWORD is not set; protected documents cannot be downloaded.');
        return ctx.internalServerError('Geschützte Dokumente sind derzeit nicht verfügbar.');
      }
      if (!passwordMatches(ctx.request.body?.password)) {
        recordFailure(ip);
        return ctx.unauthorized('Passwort ungültig.');
      }
      failedAttempts.delete(ip);
    }

    // Local upload provider: the file lives in public/uploads.
    const filePath = path.join(strapi.dirs.static.public, document.file.url);
    if (!fs.existsSync(filePath)) {
      return ctx.notFound('Datei nicht gefunden.');
    }
    const fileName = `${document.title}${document.file.ext || '.pdf'}`;
    ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    ctx.set('Cache-Control', 'no-store');
    ctx.type = document.file.mime || 'application/pdf';
    ctx.body = fs.createReadStream(filePath);
  },
}));
