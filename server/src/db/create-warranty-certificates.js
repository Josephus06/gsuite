// One-off migration: creates the Warranty Certificate (WC-##) tables and registers its page under
// Sales. A Warranty Certificate is raised against a BILLED Sales Order: it pulls that SO's job
// orders in as warranty lines (coverage type + warranty date range + optional extended warranty).
// Starts pending approval; only once Approved can it be Printed.
//
//   node src/db/create-warranty-certificates.js --dry-run
//   node src/db/create-warranty-certificates.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const PAGES = [{ route: '/warranty-certificates', name: 'Warranty Certificate', module: 'Sales' }];

const TABLES = [
  ['warranty_certificates', `
CREATE TABLE warranty_certificates (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    wc_no VARCHAR(40) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    sales_order_id BIGINT NULL,
    customer_id BIGINT NULL,
    contact_person_id BIGINT NULL,
    contact_name VARCHAR(255) NULL,
    contact_number VARCHAR(100) NULL,
    address VARCHAR(500) NULL,
    contract_description VARCHAR(500) NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending_approval',
    approved_at DATETIME NULL,
    approved_by_user_id BIGINT NULL,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    voided_at DATETIME NULL,
    voided_by_user_id BIGINT NULL,
    INDEX idx_wc_status (status),
    INDEX idx_wc_so (sales_order_id)
)`],
  ['warranty_certificate_lines', `
CREATE TABLE warranty_certificate_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    wc_id BIGINT NOT NULL,
    line_no INT NOT NULL,
    job_order_id BIGINT NULL,
    job_order_no VARCHAR(50) NULL,
    job_description VARCHAR(500) NULL,
    coverage VARCHAR(255) NULL,
    warranty_date_from DATE NULL,
    warranty_date_to DATE NULL,
    remarks VARCHAR(500) NULL,
    ext_warranty_date_from DATE NULL,
    ext_warranty_date_to DATE NULL,
    ext_remarks VARCHAR(500) NULL,
    INDEX idx_wcl_parent (wc_id)
)`],
];

async function tableExists(name) { const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]); return rows.length > 0; }

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  for (const [name, ddl] of TABLES) {
    if (await tableExists(name)) console.log(`Table ${name} already exists.`);
    else if (DRY_RUN) console.log(`Would create table ${name}.`);
    else { await pool.query(ddl); console.log(`Created table ${name}.`); }
  }

  const [admins] = await pool.query("SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const p of PAGES) {
    let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [p.route]);
    if (page) console.log(`\nPage ${p.route} already registered (id ${page.id}).`);
    else if (DRY_RUN) console.log(`\nWould register ${p.route} as "${p.name}".`);
    else {
      const [cols] = await pool.query('SHOW COLUMNS FROM pages');
      const has = new Set(cols.map((c) => c.Field));
      const fields = ['route', 'name']; const values = [p.route, p.name];
      if (has.has('module')) { fields.push('module'); values.push(p.module); }
      const [result] = await pool.query(`INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values);
      page = { id: result.insertId };
      console.log(`\nRegistered ${p.route} as "${p.name}" (id ${page.id}).`);
    }
    if (!page) continue;
    for (const user of admins) {
      const [[existing]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id]);
      if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get full access.`); continue; }
      if (existing) await pool.query('UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE WHERE id = ?', [existing.id]);
      else await pool.query('INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve) VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)', [user.id, page.id]);
      console.log(`  + ${user.display_name}: full access.`);
    }
  }
  await pool.end();
}
main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
