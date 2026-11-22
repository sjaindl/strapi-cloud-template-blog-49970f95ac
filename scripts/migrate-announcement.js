'use strict';

/**
 * Migrates the legacy ticker (getTicker.php JSON export) into the `announcement` single type.
 * Only one announcement exists; the first non-empty ticker item is used.
 *
 * Usage: node scripts/migrate-announcement.js --source <ticker.json>
 */

const { parseArgs, readSource, runMigration, setPublicPermissions, setSingle } = require('./lib/migrate-utils');

const UID = 'api::announcement.announcement';

runMigration(async () => {
  const { source } = parseArgs(['source']);
  const items = await readSource(source);
  const text = (items.find((item) => item.tickerItem && item.tickerItem.trim())?.tickerItem ?? '').trim();

  await setSingle(UID, { text, active: Boolean(text) });
  await setPublicPermissions('announcement', ['find']);
  console.log(`Announcement: ${text ? `"${text}"` : '(empty, inactive)'}`);
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
