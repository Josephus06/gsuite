// Forms > Undertime Form (asked 2026-10-20) -- the details table. The employee files it for the day
// they leave before the end of their shift: the date, their scheduled time out, the time they leave,
// the minutes short, and why.
//
// Routed as a Leave Application is (lib/leaveRoute.js): by the filer's reporting line -- noted by
// their direct supervisor when there is one below the approver, approved by the first SBU / General
// Manager / department leave approver up the line. form_requests.type is a VARCHAR, so the new type
// needs nothing there. Idempotent.
//   node src/db/add-undertime-form.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[col]] = await pool.query(
    "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_requests' AND COLUMN_NAME = 'id'");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS form_undertime_details (
      form_request_id ${col.t} NOT NULL PRIMARY KEY,
      ut_date DATE NOT NULL,
      shift_end TIME NOT NULL,
      time_out TIME NOT NULL,
      minutes INT NOT NULL DEFAULT 0,
      reason TEXT NULL,
      KEY idx_ut_date (ut_date),
      CONSTRAINT fk_ut_form FOREIGN KEY (form_request_id) REFERENCES form_requests(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  console.log('form_undertime_details ready.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
