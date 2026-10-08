// Attendance Adjustment Form (asked 2026-10-08): the paper slip an employee fills when the biometric
// has no record of a time-in or time-out -- which day, which of AM IN / AM OUT / PM IN / PM OUT /
// OT IN / OT OUT they are claiming, and why (Field Work, Business Trip, or Others with a reason such
// as "biometric error"). Noted by the immediate superior (the department's head), then approved.
//
// form_requests.type is a VARCHAR, so the new type needs no change there; its details get their own
// side table, like every other form type.
//
//   node src/db/add-form-attendance-adjustment.js
// Safe to re-run. Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[t]] = await pool.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_attendance_adjustment_details'");
  if (Number(t.n)) {
    console.log('  form_attendance_adjustment_details already there -- skipped');
  } else {
    // The parent's id type decides the foreign key's, so it is read rather than assumed.
    const [[col]] = await pool.query(
      "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_requests' AND COLUMN_NAME = 'id'");
    await pool.query(`CREATE TABLE form_attendance_adjustment_details (
      form_request_id ${col.t} NOT NULL PRIMARY KEY,
      adjustment_date DATE NOT NULL,
      am_in TIME NULL, am_out TIME NULL,
      pm_in TIME NULL, pm_out TIME NULL,
      ot_in TIME NULL, ot_out TIME NULL,
      reason VARCHAR(20) NOT NULL,
      reason_other VARCHAR(255) NULL,
      CONSTRAINT fk_faad_form FOREIGN KEY (form_request_id) REFERENCES form_requests(id) ON DELETE CASCADE
    )`);
    console.log('  created form_attendance_adjustment_details');
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
