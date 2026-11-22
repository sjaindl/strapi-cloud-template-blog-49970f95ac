module.exports = ({ env }) => ({
  upload: {
    config: {
      // Legacy club media (photos, videos, PDFs) is migrated in bulk; videos can be large.
      sizeLimit: 250 * 1024 * 1024,
      // Responsive formats the website picks from (a 245px thumbnail is always created).
      breakpoints: {
        large: 1600,
        medium: 1000,
        small: 500,
      },
    },
  },
  // Mails (Hallenturnier registrations) go out via SMTP. Without SMTP_HOST (local development) the
  // registration controller only logs them.
  ...(env('SMTP_HOST')
    ? {
        email: {
          config: {
            provider: 'nodemailer',
            providerOptions: {
              host: env('SMTP_HOST'),
              port: env.int('SMTP_PORT', 587),
              secure: env.bool('SMTP_SECURE', false),
              auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
            },
            settings: {
              defaultFrom: env('MAIL_FROM', env('SMTP_USER')),
              defaultReplyTo: env('MAIL_FROM', env('SMTP_USER')),
            },
          },
        },
      }
    : {}),
});
