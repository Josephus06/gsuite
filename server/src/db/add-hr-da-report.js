// HRD > DA Report (asked 2026-10-28). HR's monthly Discipline Management Report, on the company's
// own sheet ("DA REPORT FORMAT.xlsx"): "Discipline Management Report (OCTOBER 2026)", then a section
// per stage of the disciplinary action -- NOTICE TO EXPLAIN in the sample -- each a table of
// EMPLOYEE NAME / VIOLATION / SECTION VIOLATED / FINAL SANCTION.
//
//   hr_da_entries  (new)  one row per line of the report: the month it is reported in, its stage
//                         (section heading), the employee (name kept as printed), the violation,
//                         the section violated (picked from HRD > Violation's list, or typed) and
//                         the final sanction.
//   pages /hrd/da-report "DA Report"  View; Add; Edit; Delete; Print. System Admins get every right.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-hr-da-report.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_da_entries (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      report_month DATE NOT NULL,
      stage VARCHAR(80) NOT NULL DEFAULT 'NOTICE TO EXPLAIN',
      employee_id BIGINT NULL,
      employee_name VARCHAR(150) NOT NULL,
      violation VARCHAR(300) NOT NULL,
      violation_type_id BIGINT NULL,
      section_violated VARCHAR(300) NULL,
      final_sanction VARCHAR(200) NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_hr_da_entries_month (report_month),
      KEY idx_hr_da_entries_employee (employee_id)
    )`);
  console.log('  hr_da_entries ready');

  const ROUTE = '/hrd/da-report';
  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  let pageId = existing?.id;
  if (!pageId) {
    const [r] = await pool.query('INSERT INTO pages (route, name, is_active) VALUES (?, ?, TRUE)', [ROUTE, 'DA Report']);
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
  console.log(`  ${admins.length} System Admin(s) given every right on DA Report`);
  console.log('  HR staff: grant View/Add/Edit/Print on "DA Report" in User Permissions.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
