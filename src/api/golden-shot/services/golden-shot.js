'use strict';

/**
 * golden-shot service.
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::golden-shot.golden-shot');
