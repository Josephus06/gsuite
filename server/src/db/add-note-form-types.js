// Which forms a department head notes (asked 2026-10-08). "Note form" on a department's approver was
// one tick covering every department-noted form -- Request for Payment, Fund Transfer, Attendance
// Adjustment. note_form_types narrows it to a comma list of those types; NULL (every existing row)
// still means all of them, so nobody loses what they note today.
//
//   node src/db/add-note-form-types.js
// Safe to re-run. Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[c]] = await pool.query(
    "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'department_ticket_approvers' AND COLUMN_NAME = 'note_form_types'");
  if (Number(c.n)) console.log('  department_ticket_approvers.note_form_types already there -- skipped');
  else {
    await pool.query('ALTER TABLE department_ticket_approvers ADD COLUMN note_form_types VARCHAR(255) NULL');
    console.log('  added department_ticket_approvers.note_form_types');
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
