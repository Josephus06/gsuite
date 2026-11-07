// HRD > Regularization and HRD > Salary Adjustment (asked 2026-11-07). HR's two letters to an employee
// on the company's own templates ("regularization format.docx", "SALARY ADJUSTMENT FORMAT.docx"): the
// GraphicStar letterhead, the letter, signed by HR (Sincerely / Yours truly), Approved by the General
// Manager, and the employee's conformity line.
//
//   hr_personnel_letters  (new)  one row per letter, `kind` saying which. Keeps its own copy of what was
//                                printed (name, address, rates): a letter handed to somebody must not be
//                                reworded by a later edit to the employee record. Like the COE and Memo it
//                                goes to the General Manager HR picks, is signed in the name of the GM who
//                                approved it, and carries their e-signature once approved.
//   pages /hrd/regularization     "Regularization"
//         /hrd/salary-adjustment  "Salary Adjustment"
//         Each its own rights: View lists; Add; Edit; Delete; Print.
//         System Admins get every right; General Managers view, print, approve.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-hr-personnel-letters.js
require('dotenv').config();
const pool = require('../db');

const PAGES = [
  ['/hrd/regularization', 'Regularization'],
  ['/hrd/salary-adjustment', 'Salary Adjustment'],
];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_personnel_letters (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      letter_no VARCHAR(20) NOT NULL,
      kind ENUM('regularization', 'salary_adjustment') NOT NULL,
      status ENUM('for_approval', 'approved', 'rejected') NOT NULL DEFAULT 'for_approval',
      approver_user_id BIGINT NULL,
      approved_at DATETIME NULL,
      rejected_reason VARCHAR(500) NULL,
      decided_at DATETIME NULL,
      employee_id BIGINT NULL,
      employee_name VARCHAR(200) NOT NULL,
      employee_address VARCHAR(300) NULL,
      salutation VARCHAR(120) NULL,
      letter_date DATE NOT NULL,
      effective_date DATE NULL,
      current_rate DECIMAL(12,2) NULL,
      current_basis ENUM('monthly', 'daily') NULL,
      new_rate DECIMAL(12,2) NULL,
      new_basis ENUM('monthly', 'daily') NULL,
      prepared_by_name VARCHAR(150) NULL,
      prepared_by_title VARCHAR(150) NULL,
      signatory_name VARCHAR(150) NULL,
      signatory_title VARCHAR(150) NOT NULL DEFAULT 'General Manager',
      remarks VARCHAR(500) NULL,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_hr_personnel_letters_no (letter_no),
      KEY idx_hr_personnel_letters_kind (kind, letter_date),
      KEY idx_hr_personnel_letters_employee (employee_id)
    )`);
  console.log('  hr_personnel_letters ready');

  const [gms] = await pool.query(
    `SELECT u.id FROM users u WHERE u.is_active = 1
        AND (u.id IN (SELECT user_id FROM general_managers) OR u.account_type = 'General Manager')
      ORDER BY u.id`);
  const [permCols] = await pool.query('SHOW COLUMNS FROM user_page_permissions');
  const flags = permCols.map((c) => c.Field).filter((f) => /^can_/.test(f));
  const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");

  for (const [route, name] of PAGES) {
    const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
    let pageId = existing?.id;
    if (!pageId) {
      const [r] = await pool.query('INSERT INTO pages (route, name, is_active) VALUES (?, ?, TRUE)', [route, name]);
      pageId = r.insertId;
      console.log(`  registered ${route} (id ${pageId})`);
    } else console.log(`  page ${route} already registered (id ${pageId})`);
    for (const a of admins) {
      const [[p]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [a.id, pageId]);
      if (p) await pool.query(`UPDATE user_page_permissions SET ${flags.map((f) => `${f} = TRUE`).join(', ')} WHERE id = ?`, [p.id]);
      else await pool.query(`INSERT INTO user_page_permissions (user_id, page_id, ${flags.join(', ')}) VALUES (?, ?, ${flags.map(() => 'TRUE').join(', ')})`, [a.id, pageId]);
    }
    // The General Managers see the list (it is where they approve) and preview what they sign.
    for (const g of gms) {
      const [[p]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [g.id, pageId]);
      if (p) await pool.query('UPDATE user_page_permissions SET can_view = TRUE, can_approve = TRUE, can_print = TRUE WHERE id = ?', [p.id]);
      else await pool.query('INSERT INTO user_page_permissions (user_id, page_id, can_view, can_approve, can_print) VALUES (?, ?, TRUE, TRUE, TRUE)', [g.id, pageId]);
    }
    console.log(`  ${name}: ${admins.length} System Admin(s) every right, ${gms.length} General Manager(s) view/print/approve`);
  }
  console.log('  HR staff: grant View/Add/Edit/Print on "Regularization" and "Salary Adjustment" in User Permissions.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
