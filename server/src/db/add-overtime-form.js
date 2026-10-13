// Overtime Request form (2026-10-13) -- the details table. Two ways to file one:
//
//   For someone else (a Sales user asks Artist 1 to stay late):
//     submitted -> NOTED by the filer's department head -> APPROVED by the employee's department
//     head -> ACCEPTED or DECLINED by the employee
//   For yourself:
//     submitted -> APPROVED by your own department head (done)
//
// Department heads are the ones ticked "Note forms" on their department (Lookups > Departments),
// as for the other forms. Idempotent.
//   node src/db/add-overtime-form.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS form_overtime_details (
      form_request_id BIGINT NOT NULL PRIMARY KEY,
      for_self TINYINT(1) NOT NULL DEFAULT 0,
      target_user_id BIGINT NOT NULL,
      target_department_id BIGINT NULL,
      ot_date DATE NOT NULL,
      time_from TIME NOT NULL,
      time_to TIME NOT NULL,
      hours DECIMAL(5,2) NOT NULL DEFAULT 0,
      purpose TEXT NULL,
      reference_no VARCHAR(100) NULL,
      responded_at DATETIME NULL,
      response_remark VARCHAR(1000) NULL,
      KEY idx_ot_target_user (target_user_id),
      KEY idx_ot_target_dept (target_department_id)
    )`);
  console.log('form_overtime_details ready.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
