// A Journal raised from an approved Liquidation (Forms) -- Create Journal on the form (asked
// 2026-10-09), the other way to post one besides Create Vendor Bill. The journal carries the
// liquidation it came from, so the form shows it and refuses a second posting (by bill or journal).
//
//   journals.form_request_id   (new)   the liquidation this journal posts, else NULL
//
// Not journals.source_type/source_id: those mark a REVERSAL journal written for a voided document,
// and the bank ledger and pre-start books leave such journals out (source_type IS NULL).
//
// Idempotent. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/add-journal-liquidation-link.js
const pool = require('../db');

async function main() {
  const [col] = await pool.query("SHOW COLUMNS FROM journals LIKE 'form_request_id'");
  if (col.length) console.log('journals.form_request_id already exists.');
  else {
    await pool.query('ALTER TABLE journals ADD COLUMN form_request_id BIGINT NULL');
    console.log('Added journals.form_request_id.');
  }
  const [idx] = await pool.query("SHOW INDEX FROM journals WHERE Key_name = 'idx_journals_form_request'");
  if (idx.length) console.log('idx_journals_form_request already exists.');
  else {
    await pool.query('ALTER TABLE journals ADD INDEX idx_journals_form_request (form_request_id)');
    console.log('Added index idx_journals_form_request.');
  }
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
