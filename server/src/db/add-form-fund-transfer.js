// RFP (Fund Transfer): a Request for Payment that also names the bank the money leaves from and the
// bank it goes to (asked 2026-10-07). It is the payment form plus two fields, so it keeps its
// details in form_payment_details beside the payment form's, in two new columns pointing at the
// chart of accounts (Bank accounts only -- enforced by the route). form_requests.type is a VARCHAR,
// so the new type itself needs no migration.
//
//   node src/db/add-form-fund-transfer.js
// Safe to re-run. Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

async function hasColumn(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]);
  return Number(r.n) > 0;
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const col of ['from_account_id', 'to_account_id']) {
    if (await hasColumn('form_payment_details', col)) { console.log(`  form_payment_details.${col} already there -- skipped`); continue; }
    await pool.query(`ALTER TABLE form_payment_details ADD COLUMN ${col} BIGINT NULL`);
    console.log(`  added form_payment_details.${col}`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
