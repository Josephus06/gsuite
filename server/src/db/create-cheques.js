// One-off migration: creates the Cheque (CHK-####) tables and registers its page under Accounting.
// A Cheque pays a payee (vendor/employee/customer) for one or more expense lines, drawn against a
// bank account. GL: DR each expense account (+ VAT input on tax) / CR Expanded Withholding Tax
// (21402) for any withheld / CR the bank account for the net cash paid.
//
//   node src/db/create-cheques.js --dry-run
//   node src/db/create-cheques.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const PAGES = [{ route: '/cheques', name: 'Cheque', module: 'Accounting' }];

const TABLES = [
  ['cheques', `
CREATE TABLE cheques (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    cheque_no VARCHAR(40) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    payee_type VARCHAR(20) NULL,
    payee_id BIGINT NULL,
    payee_name VARCHAR(255) NULL,
    office_location_id BIGINT NULL,
    account_id BIGINT NULL,
    cheque_date DATE NULL,
    cheque_number VARCHAR(60) NULL,
    date_released DATE NULL,
    currency VARCHAR(10) NULL,
    conversion_rate DECIMAL(16,6) NOT NULL DEFAULT 1,
    memo VARCHAR(1000) NULL,
    subtotal DECIMAL(18,2) NOT NULL DEFAULT 0,
    discount_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    net_of_tax DECIMAL(18,2) NOT NULL DEFAULT 0,
    tax_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    withholding_tax_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    gross_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    total_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_by_user_id BIGINT NULL,
    voided_at DATETIME NULL,
    INDEX idx_chk_date (date_created),
    INDEX idx_chk_status (status)
)`],
  ['cheque_lines', `
CREATE TABLE cheque_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    cheque_id BIGINT NOT NULL,
    line_no INT NOT NULL,
    account_id BIGINT NULL,
    department_id BIGINT NULL,
    description VARCHAR(500) NULL,
    amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    tax_code_id BIGINT NULL,
    tax_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    apply_withholding_tax TINYINT NOT NULL DEFAULT 0,
    withholding_tax_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    gross_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    total_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    INDEX idx_chkl_parent (cheque_id)
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
