// Pending Billing (asked 2026-11-13): ticking wt PAR&Pics by hand asks for the date the PAR & Pics
// hard copy was sent -- kept on the mark as sent_date.
//   node src/db/add-pending-billing-sent-date.js
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  const [[c]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pending_billing_marks' AND COLUMN_NAME = 'sent_date'`);
  if (c.n) console.log('pending_billing_marks.sent_date exists');
  else {
    await pool.query('ALTER TABLE pending_billing_marks ADD COLUMN sent_date DATE NULL AFTER marked_at');
    console.log('Added pending_billing_marks.sent_date');
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
