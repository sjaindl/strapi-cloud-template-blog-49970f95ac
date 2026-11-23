'use strict';

/** Public registration route of the Torschuss Challenge form (see the controller for validation, photo and mails). */
module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/golden-shot-registrations/register',
      handler: 'api::golden-shot-registration.golden-shot-registration.register',
      config: { auth: false },
    },
  ],
};
