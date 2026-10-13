// Leave Application form (asked 2026-10-13): Sick, Vacation, Emergency and the other leaves an
// employee files. Noted by their department head (the ones ticked "Note forms" on the department,
// Lookups > Departments), then approved on Forms Approval -- the Attendance Adjustment flow.
//
// form_requests.type is a VARCHAR, so the new type needs no change there; its details get their own
// side table, like every other form type.
//
//   node src/db/add-leave-form.js
// Safe to re-run. Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[t]] = await pool.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_leave_details'");
  if (Number(t.n)) {
    console.log('  form_leave_details already there -- skipped');
  } else {
    // The parent's id type decides the foreign key's, so it is read rather than assumed.
    const [[col]] = await pool.query(
      "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_requests' AND COLUMN_NAME = 'id'");
    await pool.query(`CREATE TABLE form_leave_details (
      form_request_id ${col.t} NOT NULL PRIMARY KEY,
      leave_type VARCHAR(30) NOT NULL,
      leave_type_other VARCHAR(255) NULL,
      date_from DATE NOT NULL,
      date_to DATE NOT NULL,
      day_part VARCHAR(10) NOT NULL DEFAULT 'whole',
      days DECIMAL(5,2) NOT NULL DEFAULT 0,
      reason TEXT NULL,
      contact_while_on_leave VARCHAR(255) NULL,
      KEY idx_leave_dates (date_from, date_to),
      CONSTRAINT fk_fld_form FOREIGN KEY (form_request_id) REFERENCES form_requests(id) ON DELETE CASCADE
    )`);
    console.log('  created form_leave_details');
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
