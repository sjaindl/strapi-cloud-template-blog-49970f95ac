'use strict';

/**
 * advent-calendar service.
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::advent-calendar.advent-calendar');
