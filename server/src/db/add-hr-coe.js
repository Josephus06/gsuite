// HRD > Certificate of Employment (asked 2026-10-22). HR issues the company's two COE templates
// from the employee record and prints them on the letterhead:
//
//   standard     "This is to certify that ... has been employed with ..." (COE.docx)
//   with_rating  "... was employed with ..." plus the Performance Appraisal prior to separation,
//                Mode of Separation and Clearance Status (COE Template.docx)
//
//   hr_coes          (new)  one row per certificate issued. Keeps its own copy of the name, position
//                           and dates as printed: a certificate is a document already handed out,
//                           and a later edit to the employee must not reword it.
//   pages /hrd/coe   "Certificate of Employment"  View lists; Add issues; Edit; Delete; Print.
//                    System Admins get every right.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-hr-coe.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_coes (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      coe_no VARCHAR(20) NOT NULL,
      coe_type ENUM('standard', 'with_rating') NOT NULL DEFAULT 'standard',
      employee_id BIGINT NULL,
      employee_name VARCHAR(200) NOT NULL,
      position_title VARCHAR(150) NULL,
      date_from DATE NULL,
      date_to DATE NULL,
      pronoun ENUM('he', 'she', 'either') NOT NULL DEFAULT 'either',
      issued_to VARCHAR(200) NULL,
      issued_date DATE NOT NULL,
      ratings JSON NULL,
      mode_of_separation VARCHAR(150) NULL,
      clearance_status VARCHAR(150) NULL,
      signatory_name VARCHAR(150) NOT NULL DEFAULT 'JIMMY W. WU',
      signatory_title VARCHAR(150) NOT NULL DEFAULT 'General Manager',
      remarks VARCHAR(500) NULL,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_hr_coes_no (coe_no),
      KEY idx_hr_coes_employee (employee_id),
      KEY idx_hr_coes_issued (issued_date)
    )`);
  console.log('  hr_coes ready');

  const ROUTE = '/hrd/coe';
  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  let pageId = existing?.id;
  if (!pageId) {
    const [r] = await pool.query('INSERT INTO pages (route, name, is_active) VALUES (?, ?, TRUE)', [ROUTE, 'Certificate of Employment']);
    pageId = r.insertId;
    console.log(`  registered ${ROUTE} (id ${pageId})`);
  } else console.log(`  page ${ROUTE} already registered (id ${pageId})`);
  const [permCols] = await pool.query('SHOW COLUMNS FROM user_page_permissions');
  const flags = permCols.map((c) => c.Field).filter((f) => /^can_/.test(f));
  const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const a of admins) {
    const [[p]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [a.id, pageId]);
    if (p) await pool.query(`UPDATE user_page_permissions SET ${flags.map((f) => `${f} = TRUE`).join(', ')} WHERE id = ?`, [p.id]);
    else await pool.query(`INSERT INTO user_page_permissions (user_id, page_id, ${flags.join(', ')}) VALUES (?, ?, ${flags.map(() => 'TRUE').join(', ')})`, [a.id, pageId]);
  }
  console.log(`  ${admins.length} System Admin(s) given every right on Certificate of Employment`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
