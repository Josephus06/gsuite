// Fund Transfer Request Form with several banks (asked 2026-10-13): Bank 1 to Banks 2 and 3, or
// Banks 1 and 2 to Bank 3. Each Particulars line carries its own From and To bank, so every amount
// says where it moves; the form's own From / To (form_payment_details) stay for older forms and are
// filled only when all of a form's lines share one.
//
//   node src/db/add-form-line-banks.js
// Safe to re-run. Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const col of ['from_account_id', 'to_account_id']) {
    const [[c]] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_request_items' AND COLUMN_NAME = ?`, [col]);
    if (Number(c.n)) { console.log(`  form_request_items.${col} already there`); continue; }
    await pool.query(`ALTER TABLE form_request_items ADD COLUMN ${col} BIGINT NULL`);
    console.log(`  + form_request_items.${col}`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
