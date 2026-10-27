// HRD > Memo (asked 2026-10-27). HR's memos to employees on the company's own template
// ("NOVEMBER 2026.docx"): the GraphicStar letterhead, TO / FROM / DATE / SUBJECT, a heading, the body
// -- paragraphs and tables (the holiday list) -- then Prepared by HR and Approved by the General Manager.
//
//   hr_memos        (new)  one row per memo. The body is a list of blocks, each a paragraph or a table.
//                          Like the COE it goes to the General Manager HR picks, is signed in the name of
//                          the GM who approved it, and carries their e-signature once approved.
//   pages /hrd/memo "Memo"  View lists; Add; Edit; Delete; Print.
//                    System Admins get every right; General Managers view, print, approve.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-hr-memo.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_memos (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      memo_no VARCHAR(20) NOT NULL,
      status ENUM('for_approval', 'approved', 'rejected') NOT NULL DEFAULT 'for_approval',
      approver_user_id BIGINT NULL,
      approved_at DATETIME NULL,
      rejected_reason VARCHAR(500) NULL,
      decided_at DATETIME NULL,
      memo_to VARCHAR(200) NOT NULL DEFAULT 'ALL EMPLOYEES',
      memo_from VARCHAR(200) NOT NULL DEFAULT 'HR DEPARTMENT',
      memo_date DATE NOT NULL,
      subject VARCHAR(250) NOT NULL,
      heading VARCHAR(150) NULL,
      body JSON NULL,
      prepared_by_name VARCHAR(150) NULL,
      prepared_by_title VARCHAR(150) NULL,
      signatory_name VARCHAR(150) NULL,
      signatory_title VARCHAR(150) NOT NULL DEFAULT 'General Manager',
      remarks VARCHAR(500) NULL,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_hr_memos_no (memo_no),
      KEY idx_hr_memos_date (memo_date)
    )`);
  console.log('  hr_memos ready');

  const [gms] = await pool.query(
    `SELECT u.id FROM users u WHERE u.is_active = 1
        AND (u.id IN (SELECT user_id FROM general_managers) OR u.account_type = 'General Manager')
      ORDER BY u.id`);

  const ROUTE = '/hrd/memo';
  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  let pageId = existing?.id;
  if (!pageId) {
    const [r] = await pool.query('INSERT INTO pages (route, name, is_active) VALUES (?, ?, TRUE)', [ROUTE, 'Memo']);
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
  console.log(`  ${admins.length} System Admin(s) given every right on Memo`);
  // The General Managers see the list (it is where they approve) and preview what they sign.
  for (const g of gms) {
    const [[p]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [g.id, pageId]);
    if (p) await pool.query('UPDATE user_page_permissions SET can_view = TRUE, can_approve = TRUE, can_print = TRUE WHERE id = ?', [p.id]);
    else await pool.query('INSERT INTO user_page_permissions (user_id, page_id, can_view, can_approve, can_print) VALUES (?, ?, TRUE, TRUE, TRUE)', [g.id, pageId]);
  }
  console.log(`  ${gms.length} General Manager(s) can view, preview and approve`);
  console.log('  HR staff: grant View/Add/Edit/Print on "Memo" in User Permissions.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
