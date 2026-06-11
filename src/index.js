'use strict';
const bootstrap = require("./bootstrap");

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/*{ strapi }*/) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }) {
    let existingCats = await strapi.documents('api::event-category.event-category').findMany({
      limit: 2,
    });

    let targetCategoryDocumentIds = [];

    if (existingCats.length === 0) {
      console.log('Creating event categories (Tech & Musik)...');

      const catTechEn = await strapi.documents('api::event-category.event-category').create({
        locale: 'en',
        status: 'published',
        data: {
          Category_ID: '4IonmIQcPr2vUYzh9X4FRF',
          Category_Name: 'Technology',
          type: 'event_category',
        },
      });
      await strapi.documents('api::event-category.event-category').update({
        documentId: catTechEn.documentId,
        locale: 'de',
        status: 'published',
        data: {
          Category_Name: 'Technologie',
        },
      });

      const catMusicEn = await strapi.documents('api::event-category.event-category').create({
        locale: 'en',
        status: 'published',
        data: {
          Category_ID: 'sx62QbMcyDZbOwjHGFyg8',
          Category_Name: 'Music & Art',
          type: 'event_category',
        },
      });
      await strapi.documents('api::event-category.event-category').update({
        documentId: catMusicEn.documentId,
        locale: 'de',
        status: 'published',
        data: {
          Category_Name: 'Musik & Kunst',
        },
      });

      targetCategoryDocumentIds = [catTechEn.documentId, catMusicEn.documentId];
      console.log('✅ Successfully created event categories');
    } else {
      targetCategoryDocumentIds = existingCats.map((cat) => cat.documentId);
    }

    // Create events
    const existingEvents = await strapi.documents('api::event.event').findMany({
      limit: 1,
    });

    if (existingEvents.length === 0 && targetCategoryDocumentIds.length > 0) {
      console.log('Creating localized events...');

      const placeholderImageId = 9;

      for (let i = 1; i <= 100; i++) {
        const chosenCategoryDocumentId = targetCategoryDocumentIds[i % targetCategoryDocumentIds.length];

        const englishEvent = await strapi.documents('api::event.event').create({
          locale: 'en',
          status: 'published',
          data: {
            title: `Tech & Innovation Summit #${i}`,
            dateTime: new Date(2026, 7, (i % 28) + 1, 19, 0).toISOString(),
            price: Math.floor(Math.random() * 150),
            currency: i % 2 === 0 ? 'EUR' : 'USD',
            locationName: `Javits Center Hall ${i}, NY`,
            type: 'event',
            image: placeholderImageId,
            event_category: chosenCategoryDocumentId,
            description: [
              {
                type: 'paragraph',
                children: [{ type: 'text', text: `Welcome to the English description for event sample number ${i}.` }]
              }
            ]
          }
        });

        await strapi.documents('api::event.event').update({
          documentId: englishEvent.documentId,
          locale: 'de',
          status: 'published',
          data: {
            title: `Tech & Innovationsgipfel #${i}`,
            locationName: `Javits Zentrum Halle ${i}, NY`,
            image: placeholderImageId,
            description: [
              {
                type: 'paragraph',
                children: [{ type: 'text', text: `Willkommen zur deutschen Beschreibung für die Veranstaltungsnummer ${i}.` }]
              }
            ]
          }
        });
      }

      console.log('🏁 Done! Events and event categories successfully created');
    }
  },
};