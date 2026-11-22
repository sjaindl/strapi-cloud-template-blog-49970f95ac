module.exports = () => ({
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
});
