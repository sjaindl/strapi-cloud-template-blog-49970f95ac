'use strict';

/** Public download route; protected documents need the members' password (see the controller). */
module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/documents/:documentId/download',
      handler: 'api::document.document.download',
      config: { auth: false },
    },
  ],
};
