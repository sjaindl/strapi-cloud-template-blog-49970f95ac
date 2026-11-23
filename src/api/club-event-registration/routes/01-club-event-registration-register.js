'use strict';

/** Public registration/order route of the event pages (see the controller for validation and mails). */
module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/club-event-registrations/register',
      handler: 'api::club-event-registration.club-event-registration.register',
      config: { auth: false },
    },
  ],
};
