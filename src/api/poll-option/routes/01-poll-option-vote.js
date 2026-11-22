'use strict';

/** Public vote route (see the controller for the limits). */
module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/poll-options/:documentId/vote',
      handler: 'api::poll-option.poll-option.vote',
      config: { auth: false },
    },
  ],
};
