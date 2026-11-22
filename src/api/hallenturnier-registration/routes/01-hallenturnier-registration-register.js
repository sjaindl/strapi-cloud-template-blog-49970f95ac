'use strict';

/** Public registration route of the Hallenturnier form (see the controller for validation and mails). */
module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/hallenturnier-registrations/register',
      handler: 'api::hallenturnier-registration.hallenturnier-registration.register',
      config: { auth: false },
    },
  ],
};
