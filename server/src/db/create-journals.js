// One-off migration: creates the Journal (JRNL-####) tables and registers its page under
// Accounting. A Journal is a manual general-journal entry -- balanced debit/credit lines posted
// directly to the GL (its GL Impact == its lines). Each line carries an account, optional
// department + party (Vendor/Customer/Employee), a debit or credit, and a memo.
//
//   node src/db/create-journals.js --dry-run
//   node src/db/create-journals.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const PAGES = [{ route: '/journals', name: 'Journal', module: 'Accounting' }];

const TABLES = [
  ['journals', `
CREATE TABLE journals (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    journal_no VARCHAR(40) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    location_id BIGINT NULL,
    currency VARCHAR(10) NULL,
    conversion DECIMAL(16,6) NOT NULL DEFAULT 1,
    memo VARCHAR(1000) NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'SAVED',
    total_debit DECIMAL(18,2) NOT NULL DEFAULT 0,
    total_credit DECIMAL(18,2) NOT NULL DEFAULT 0,
    source_type VARCHAR(50) NULL,
    source_id BIGINT NULL,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    voided_at DATETIME NULL,
    voided_by_user_id BIGINT NULL,
    INDEX idx_jrnl_date (date_created),
    INDEX idx_jrnl_status (status)
)`],
  ['journal_lines', `
CREATE TABLE journal_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    journal_id BIGINT NOT NULL,
    line_no INT NOT NULL,
    account_id BIGINT NULL,
    department_id BIGINT NULL,
    party_type VARCHAR(20) NULL,
    party_id BIGINT NULL,
    party_name VARCHAR(255) NULL,
    debit DECIMAL(18,2) NOT NULL DEFAULT 0,
    credit DECIMAL(18,2) NOT NULL DEFAULT 0,
    memo VARCHAR(500) NULL,
    INDEX idx_jrnll_parent (journal_id)
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
