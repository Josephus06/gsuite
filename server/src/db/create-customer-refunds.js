// One-off migration: creates the Customer Refund tables and registers its page. A Customer
// Refund (CRFND-####) returns cash to a customer against one or more of their Customer Payments
// -- the AR-side mirror of returning money. It debits Accounts Receivable Trade (12100) and
// credits the Customer Refund clearing account (10005), matching the live GL Impact tab.
//
// The page is registered and admins granted full access in this same migration, so the module
// can never be left unreachable (requirePermission resolves a route to a page before checking).
//
// Idempotent -- safe to re-run:
//   node src/db/create-customer-refunds.js --dry-run   (report only)
//   node src/db/create-customer-refunds.js             (apply)
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const PAGES = [
  { route: '/customer-refunds', name: 'Customer Refunds', module: 'Accounting' },
];

// The two GL accounts a refund posts against.
const REQUIRED_ACCOUNTS = ['12100', '10005'];

const TABLES = [
  ['customer_refunds', `
CREATE TABLE customer_refunds (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    customer_refund_no VARCHAR(30) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    customer_id BIGINT NOT NULL,
    department_id BIGINT NULL,
    office_location_id BIGINT NULL,
    account_id BIGINT NULL,
    ar_account_id BIGINT NULL,
    payment_method_id BIGINT NULL,
    refund_amount DECIMAL(14,2) DEFAULT 0,
    memo VARCHAR(500),
    issued_by_user_id BIGINT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'posted',
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_by_user_id BIGINT NULL,
    voided_at DATETIME NULL,
    INDEX idx_crfnd_customer (customer_id)
)`],
  ['customer_refund_lines', `
CREATE TABLE customer_refund_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    customer_refund_id BIGINT NOT NULL,
    customer_payment_id BIGINT NULL,
    original_amount DECIMAL(14,2) DEFAULT 0,
    refund_amount DECIMAL(14,2) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_crfndl_refund (customer_refund_id)
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

  const [accounts] = await pool.query(
    'SELECT account_code, account_name FROM chart_of_accounts WHERE account_code IN (?)', [REQUIRED_ACCOUNTS],
  );
  const found = new Set(accounts.map((a) => a.account_code));
  const missing = REQUIRED_ACCOUNTS.filter((c) => !found.has(c));
  if (missing.length) {
    console.warn(`\n!! Missing chart_of_accounts rows: ${missing.join(', ')}.`);
    console.warn('   The Customer Refund GL Impact tab will be empty until they exist.');
  } else {
    console.log(`\nAll ${REQUIRED_ACCOUNTS.length} required GL accounts present (${accounts.map((a) => `${a.account_code} ${a.account_name}`).join(', ')}).`);
  }

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
