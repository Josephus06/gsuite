// One-off migration: creates the Commission module setup tables and registers their
// pages. Commission Table (rate schemes) and Employee Quota (monthly targets) are both
// admin-maintained master data -- see the block comments in schema.sql.
//
// Both pages are registered and admins granted full access in the same run, so neither
// module can be left unreachable: requirePermission resolves a route to a page before it
// checks anything, so a missing row 403s every user including System Admin.
//
// Idempotent -- safe to re-run:
//   node src/db/create-commission-module.js --dry-run   (report only)
//   node src/db/create-commission-module.js             (apply)
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const PAGES = [
  { route: '/commission-schemes', name: 'Commission Table' },
  { route: '/employee-quotas', name: 'Employee Quota' },
];

const TABLES = [
  ['commission_schemes', `
CREATE TABLE commission_schemes (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
)`],
  ['commission_scheme_brackets', `
CREATE TABLE commission_scheme_brackets (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    commission_scheme_id BIGINT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    min_weighted_sales DECIMAL(16,2) NOT NULL,
    max_weighted_sales DECIMAL(16,2) NOT NULL,
    commission_amount DECIMAL(16,2) NOT NULL DEFAULT 0,
    commission_rate DECIMAL(16,2) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_csb_scheme (commission_scheme_id)
)`],
  ['employee_quotas', `
CREATE TABLE employee_quotas (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    employee_id BIGINT NOT NULL,
    year INT NOT NULL,
    month TINYINT NOT NULL,
    quota DECIMAL(16,2) NOT NULL DEFAULT 0,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uq_emp_quota (employee_id, year, month)
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
      if (has.has('module')) { fields.push('module'); values.push('Commission'); }
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
