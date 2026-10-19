// Three HR forms (asked 2026-10-19), after HR's own sheets:
//
//   hmo_enrollment  LIFE AND HEALTH - ENROLLMENT  -- members added to the Life & Health HMP health
//                   insurance: P (principal) / D (dependent), family name, first name, M.I., birthday,
//                   gender, single / married, relationship, position, plan, remarks
//   hmo_deletion    LIFE AND HEALTH - DELETION    -- members removed: P / D, name, company, reason
//   bpi_deletion    BPI DELETION                  -- letter asking BPI to drop separated employees from
//                   the payroll list: name, BPI account number, remarks
//
// Each is requested by HR, noted by the department head and approved on Forms Approval, as the
// other HR forms. They share one lines table; each form uses its own columns (routes/forms.js
// MEMBER_FORMS). form_requests.type is a VARCHAR, so the new types need no change there.
//
//   node src/db/add-hr-member-forms.js
// Safe to re-run. Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

async function tableExists(name) {
  const [[t]] = await pool.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [name]);
  return Number(t.n) > 0;
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[col]] = await pool.query(
    "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_requests' AND COLUMN_NAME = 'id'");

  if (await tableExists('form_member_details')) console.log('  form_member_details already there -- skipped');
  else {
    await pool.query(`CREATE TABLE form_member_details (
      form_request_id ${col.t} NOT NULL PRIMARY KEY,
      enrollment_for VARCHAR(120) NULL,
      letter_date DATE NULL,
      CONSTRAINT fk_fmd_form FOREIGN KEY (form_request_id) REFERENCES form_requests(id) ON DELETE CASCADE
    )`);
    console.log('  created form_member_details');
  }

  if (await tableExists('form_member_lines')) console.log('  form_member_lines already there -- skipped');
  else {
    await pool.query(`CREATE TABLE form_member_lines (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      form_request_id ${col.t} NOT NULL,
      line_no INT NOT NULL DEFAULT 1,
      member_type CHAR(1) NULL,
      family_name VARCHAR(120) NULL,
      first_name VARCHAR(120) NULL,
      middle_initial VARCHAR(10) NULL,
      full_name VARCHAR(255) NULL,
      birthday DATE NULL,
      gender CHAR(1) NULL,
      civil_status VARCHAR(20) NULL,
      relationship VARCHAR(60) NULL,
      position VARCHAR(120) NULL,
      plan VARCHAR(120) NULL,
      company VARCHAR(255) NULL,
      reason VARCHAR(500) NULL,
      bank_account_no VARCHAR(60) NULL,
      remarks VARCHAR(500) NULL,
      KEY idx_member_lines_form (form_request_id),
      CONSTRAINT fk_fml_form FOREIGN KEY (form_request_id) REFERENCES form_requests(id) ON DELETE CASCADE
    )`);
    console.log('  created form_member_lines');
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
