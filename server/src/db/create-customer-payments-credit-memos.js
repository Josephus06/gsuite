// One-off migration: creates the Customer Payment and Credit Memo tables and registers
// their pages. These are the AR mirrors of Bill Payment / Bill Credit, reached from an
// Open Invoice's own "Accept Payment" and "Credit Memo" buttons.
//
// Both pages are registered and admins granted full access in this same migration, so
// neither module can be left unreachable: requirePermission resolves a route to a page
// before it checks anything, so a missing row 403s every user including System Admin.
//
// Idempotent -- safe to re-run:
//   node src/db/create-customer-payments-credit-memos.js --dry-run   (report only)
//   node src/db/create-customer-payments-credit-memos.js             (apply)
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const PAGES = [
  { route: '/customer-payments', name: 'Customer Payments', module: 'Accounting' },
  { route: '/credit-memos', name: 'Credit Memos', module: 'Accounting' },
];

// The two GL accounts these transactions post against, beyond the ones Sales Invoice
// already uses. Reported rather than created -- inventing a chart-of-accounts row is a
// decision for whoever owns the CoA.
const REQUIRED_ACCOUNTS = ['12100', '30100', '21100'];

const TABLES = [
  ['customer_payments', `
CREATE TABLE customer_payments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    customer_payment_no VARCHAR(30) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    customer_id BIGINT NOT NULL,
    department_id BIGINT NULL,
    office_location_id BIGINT NULL,
    ar_account_id BIGINT NULL,
    deposit_account_id BIGINT NULL,
    receipt_type VARCHAR(60),
    or_no VARCHAR(60),
    payment_type VARCHAR(60),
    issued_by_user_id BIGINT NULL,
    payment_method_id BIGINT NULL,
    payment_amount DECIMAL(14,2) DEFAULT 0,
    applied_amount DECIMAL(14,2) DEFAULT 0,
    unapplied_amount DECIMAL(14,2) DEFAULT 0,
    memo VARCHAR(500),
    status VARCHAR(30) NOT NULL DEFAULT 'not_deposited',
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_by_user_id BIGINT NULL,
    voided_at DATETIME NULL,
    INDEX idx_cpay_customer (customer_id)
)`],
  ['customer_payment_lines', `
CREATE TABLE customer_payment_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    customer_payment_id BIGINT NOT NULL,
    sales_invoice_id BIGINT NULL,
    credit_memo_id BIGINT NULL,
    applied_amount DECIMAL(14,2) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_cpayl_payment (customer_payment_id)
)`],
  ['credit_memos', `
CREATE TABLE credit_memos (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    credit_memo_no VARCHAR(30) UNIQUE NOT NULL,
    sales_invoice_id BIGINT NOT NULL,
    customer_id BIGINT NOT NULL,
    date_created DATE NOT NULL,
    office_location_id BIGINT NULL,
    ar_account_id BIGINT NULL,
    memo VARCHAR(500),
    subtotal DECIMAL(14,2) DEFAULT 0,
    discount_amount DECIMAL(14,2) DEFAULT 0,
    net_of_tax DECIMAL(14,2) DEFAULT 0,
    tax_amount DECIMAL(14,2) DEFAULT 0,
    gross_amount DECIMAL(14,2) DEFAULT 0,
    applied_amount DECIMAL(14,2) DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_by_user_id BIGINT NULL,
    voided_at DATETIME NULL,
    INDEX idx_cm_invoice (sales_invoice_id),
    INDEX idx_cm_customer (customer_id)
)`],
  ['credit_memo_lines', `
CREATE TABLE credit_memo_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    credit_memo_id BIGINT NOT NULL,
    line_no INT NOT NULL,
    sales_invoice_line_id BIGINT NULL,
    job_order_id BIGINT NULL,
    item_id BIGINT NULL,
    item_name VARCHAR(255),
    description VARCHAR(500),
    department_id BIGINT NULL,
    quantity DECIMAL(14,4),
    units VARCHAR(30),
    price_per_unit DECIMAL(14,4),
    subtotal DECIMAL(14,2),
    disc_percent DECIMAL(5,2),
    disc_per_unit DECIMAL(14,4),
    disc_amount DECIMAL(14,2),
    disc_price_per_unit DECIMAL(14,4),
    net_of_tax DECIMAL(14,2),
    tax_code VARCHAR(30),
    tax_amount DECIMAL(14,2),
    gross_amount DECIMAL(14,2),
    INDEX idx_cml_memo (credit_memo_id)
)`],
  ['credit_memo_applications', `
CREATE TABLE credit_memo_applications (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    credit_memo_id BIGINT NOT NULL,
    sales_invoice_id BIGINT NOT NULL,
    applied_amount DECIMAL(14,2) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_cma_memo (credit_memo_id)
)`],
];

async function tableExists(name) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return rows.length > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  for (const [name, ddl] of TABLES) {
    if (await tableExists(name)) {
      console.log(`Table ${name} already exists.`);
    } else if (DRY_RUN) {
      console.log(`Would create table ${name}.`);
    } else {
      await pool.query(ddl);
      console.log(`Created table ${name}.`);
    }
  }

  // A saved Customer Payment starts NOT DEPOSITED -- the cash has been received but
  // hasn't yet been swept into the bank. Fixes up a database created by an earlier run of
  // this migration, which defaulted the column to 'open' like the other transactions do.
  if (await tableExists('customer_payments')) {
    const [cpCols] = await pool.query('SHOW COLUMNS FROM customer_payments');
    const statusCol = cpCols.find((c) => c.Field === 'status');
    if (statusCol && statusCol.Default !== 'not_deposited') {
      if (DRY_RUN) {
        console.log(`\nWould change customer_payments.status default from '${statusCol.Default}' to 'not_deposited'.`);
      } else {
        await pool.query("ALTER TABLE customer_payments MODIFY status VARCHAR(30) NOT NULL DEFAULT 'not_deposited'");
        console.log(`\nChanged customer_payments.status default from '${statusCol.Default}' to 'not_deposited'.`);
      }
    }
    const [[stale]] = await pool.query("SELECT COUNT(*) AS c FROM customer_payments WHERE status = 'open'");
    if (stale.c) {
      if (DRY_RUN) {
        console.log(`Would restate ${stale.c} payment(s) from 'open' to 'not_deposited'.`);
      } else {
        await pool.query("UPDATE customer_payments SET status = 'not_deposited' WHERE status = 'open'");
        console.log(`Restated ${stale.c} payment(s) from 'open' to 'not_deposited'.`);
      }
    }
  }

  const [accounts] = await pool.query(
    'SELECT account_code, account_name FROM chart_of_accounts WHERE account_code IN (?)', [REQUIRED_ACCOUNTS],
  );
  const found = new Set(accounts.map((a) => a.account_code));
  const missing = REQUIRED_ACCOUNTS.filter((c) => !found.has(c));
  if (missing.length) {
    console.warn(`\n!! Missing chart_of_accounts rows: ${missing.join(', ')}.`);
    console.warn('   GL Impact tabs for these transactions will be empty until they exist.');
  } else {
    console.log(`\nAll ${REQUIRED_ACCOUNTS.length} required GL accounts present.`);
  }

  // A cash/bank account is where a received payment lands. Reported so a database with
  // none makes that obvious rather than the deposit picker silently coming up empty.
  const [[cash]] = await pool.query(
    "SELECT COUNT(*) AS c FROM chart_of_accounts WHERE account_name LIKE '%Cash%' OR account_name LIKE '%Bank%'",
  );
  console.log(`${cash.c} cash/bank account(s) available to deposit into.`);

  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE",
  );

  for (const p of PAGES) {
    let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [p.route]);
    if (page) {
      console.log(`\nPage ${p.route} already registered (id ${page.id}).`);
    } else if (DRY_RUN) {
      console.log(`\nWould register ${p.route} as "${p.name}".`);
    } else {
      const [cols] = await pool.query('SHOW COLUMNS FROM pages');
      const has = new Set(cols.map((c) => c.Field));
      const fields = ['route', 'name'];
      const values = [p.route, p.name];
      if (has.has('module')) { fields.push('module'); values.push(p.module); }
      const [result] = await pool.query(
        `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
        values,
      );
      page = { id: result.insertId };
      console.log(`\nRegistered ${p.route} as "${p.name}" (id ${page.id}).`);
    }

    if (!page) {
      console.log(`  Would grant full access to ${admins.length} admin(s) once the page row exists.`);
      continue;
    }
    for (const user of admins) {
      const [[existing]] = await pool.query(
        'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id],
      );
      if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get full access.`); continue; }
      if (existing) {
        await pool.query(
          'UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE WHERE id = ?',
          [existing.id],
        );
      } else {
        await pool.query(
          `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve)
           VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)`,
          [user.id, page.id],
        );
      }
      console.log(`  + ${user.display_name}: full access.`);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
