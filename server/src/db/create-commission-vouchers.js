// One-off migration: creates the Commission Voucher tables and registers its page. A Commission
// Voucher (COMVCH-####) is the RELEASE/payment side of Commission Payable -- it pays (full or
// partial) one or more of an employee's Commission Payables from a cash/bank account, optionally
// net of expense adjustments (e.g. an employee advance deducted). It posts:
//   DR 24200 Commission Payable  (one line per commission released -- settles the liability)
//   +/- each expense: a POSITIVE expense amount debits its account, a NEGATIVE one credits it
//   CR <cash/bank account>       (= total released + sum of expense amounts = Total Payments)
//
// The page is registered and admins granted full access in this same migration.
//
//   node src/db/create-commission-vouchers.js --dry-run   (report only)
//   node src/db/create-commission-vouchers.js             (apply)
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const PAGES = [{ route: '/commission-vouchers', name: 'Commission Voucher', module: 'Accounting' }];
const REQUIRED_ACCOUNTS = ['24200'];

const TABLES = [
  ['commission_vouchers', `
CREATE TABLE commission_vouchers (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    voucher_no VARCHAR(30) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    employee_id BIGINT NOT NULL,
    payee_name VARCHAR(255),
    reference_no VARCHAR(191),
    memo VARCHAR(500),
    payment_method_id BIGINT NULL,
    cash_bank_account_id BIGINT NULL,
    payment_type VARCHAR(20) NOT NULL DEFAULT 'full',
    date_released DATE NULL,
    total_payments DECIMAL(16,2) DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'posted',
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_by_user_id BIGINT NULL,
    voided_at DATETIME NULL,
    INDEX idx_cv_employee (employee_id)
)`],
  ['commission_voucher_lines', `
CREATE TABLE commission_voucher_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    commission_voucher_id BIGINT NOT NULL,
    commission_payable_id BIGINT NOT NULL,
    released_amount DECIMAL(16,2) NOT NULL,
    INDEX idx_cvl_voucher (commission_voucher_id)
)`],
  ['commission_voucher_expenses', `
CREATE TABLE commission_voucher_expenses (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    commission_voucher_id BIGINT NOT NULL,
    account_id BIGINT NOT NULL,
    description VARCHAR(255),
    amount DECIMAL(16,2) NOT NULL,
    INDEX idx_cve_voucher (commission_voucher_id)
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

  const [accounts] = await pool.query('SELECT account_code, account_name FROM chart_of_accounts WHERE account_code IN (?)', [REQUIRED_ACCOUNTS]);
  const found = new Set(accounts.map((a) => a.account_code));
  const missing = REQUIRED_ACCOUNTS.filter((c) => !found.has(c));
  if (missing.length) console.warn(`\n!! Missing chart_of_accounts rows: ${missing.join(', ')}.`);
  else console.log(`\nRequired GL account present (${accounts.map((a) => `${a.account_code} ${a.account_name}`).join(', ')}).`);

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
