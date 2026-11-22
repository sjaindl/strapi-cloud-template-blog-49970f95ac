'use strict';

/**
 * scorer service.
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::scorer.scorer');
