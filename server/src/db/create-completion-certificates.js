// Certificate of Completion (COC-##), under Sales (asked 2026-10-28), as the source's
// completion_certificate_crud has it: raised against a BILLED Sales Order -- Date Created, SO #, PO #,
// Customer, Submitted By, Project Name, Location, Contract Package -- with two lists of the
// customer's own contact persons: the Approvers and the Certifiers who sign it.
//
//   completion_certificates          (new)  the header
//   completion_certificate_signers   (new)  one row per approver / certifier, in signing order; the
//                                           name and job title are kept as printed
//   pages /completion-certificates "Certificate of Completion" (Sales). System Admins get every right.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/create-completion-certificates.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS completion_certificates (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      coc_no VARCHAR(40) NOT NULL,
      date_created DATE NOT NULL,
      sales_order_id BIGINT NULL,
      po_no VARCHAR(100) NULL,
      customer_id BIGINT NULL,
      submitted_by_employee_id BIGINT NULL,
      submitted_by_name VARCHAR(150) NULL,
      project_name VARCHAR(500) NULL,
      location VARCHAR(500) NULL,
      contract_package VARCHAR(1000) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending_approval',
      approved_at DATETIME NULL,
      approved_by_user_id BIGINT NULL,
      voided_at DATETIME NULL,
      voided_by_user_id BIGINT NULL,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      KEY idx_coc_status (status),
      KEY idx_coc_so (sales_order_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS completion_certificate_signers (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      coc_id BIGINT NOT NULL,
      role ENUM('approver', 'certifier') NOT NULL,
      line_no INT NOT NULL,
      contact_id BIGINT NULL,
      name VARCHAR(255) NOT NULL,
      job_title VARCHAR(255) NULL,
      KEY idx_cocs_parent (coc_id, role, line_no)
    )`);
  console.log('  completion_certificates, completion_certificate_signers ready');

  const ROUTE = '/completion-certificates';
  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  let pageId = existing?.id;
  if (!pageId) {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const hasModule = cols.some((c) => c.Field === 'module');
    const [r] = await pool.query(
      `INSERT INTO pages (route, name${hasModule ? ', module' : ''}, is_active) VALUES (?, ?${hasModule ? ', ?' : ''}, TRUE)`,
      hasModule ? [ROUTE, 'Certificate of Completion', 'Sales'] : [ROUTE, 'Certificate of Completion']);
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
  console.log(`  ${admins.length} System Admin(s) given every right on Certificate of Completion`);
  console.log('  Sales staff: grant View/Add/Edit/Print on "Certificate of Completion" in User Permissions.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
