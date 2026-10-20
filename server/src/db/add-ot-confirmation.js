// Overtime Request: the ACTUAL time, confirmed after approval (asked 2026-10-20) -- filed for 4 hours,
// worked 3. The person who filed the request confirms it: once it is approved (for themself) or
// accepted by the employee it is for (for someone else).
//
//   form_overtime_details.actual_time_from      (new)  the actual start
//   form_overtime_details.actual_time_to        (new)  the actual end
//   form_overtime_details.actual_hours          (new)  hours between them (past midnight counts on)
//   form_overtime_details.ot_confirmed_at       (new)  when it was confirmed
//   form_overtime_details.ot_confirmed_by_user_id (new) who confirmed it (the filer)
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-ot-confirmation.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const [col, def] of [
    ['actual_time_from', 'TIME NULL'], ['actual_time_to', 'TIME NULL'], ['actual_hours', 'DECIMAL(5,2) NULL'],
    ['ot_confirmed_at', 'DATETIME NULL'], ['ot_confirmed_by_user_id', 'BIGINT NULL'],
  ]) {
    const [c] = await pool.query('SHOW COLUMNS FROM form_overtime_details LIKE ?', [col]);
    if (c.length) console.log(`  form_overtime_details.${col} already there -- skipped`);
    else { await pool.query(`ALTER TABLE form_overtime_details ADD COLUMN ${col} ${def}`); console.log(`  added form_overtime_details.${col}`); }
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
