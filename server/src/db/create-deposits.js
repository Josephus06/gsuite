// One-off migration: creates the Bank Deposit (BD-####) table and registers its page under
// Accounting. A Deposit takes one or more NOT-DEPOSITED customer payments and deposits them into a
// bank account: DR <bank account> / CR 10006 Undeposited Funds. Each payment links back via
// customer_payments.deposit_id; while a payment belongs to a deposit its own GL posts to Undeposited
// Funds instead of straight to the bank (so historical payments -- which have no deposit -- are
// untouched and keep debiting their deposit account directly).
//
//   node src/db/create-deposits.js --dry-run
//   node src/db/create-deposits.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const PAGES = [{ route: '/deposits', name: 'Deposit', module: 'Accounting' }];

async function tableExists(name) { const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]); return rows.length > 0; }
async function colExists(table, column) { const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]); return rows.length > 0; }

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  if (await tableExists('bank_deposits')) console.log('Table bank_deposits already exists.');
  else if (DRY_RUN) console.log('Would create table bank_deposits.');
  else {
    await pool.query(`
CREATE TABLE bank_deposits (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    bd_no VARCHAR(40) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    account_id BIGINT NULL,
    memo VARCHAR(1000) NULL,
    total_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_by_user_id BIGINT NULL,
    voided_at DATETIME NULL,
    INDEX idx_bd_date (date_created),
    INDEX idx_bd_status (status)
)`);
    console.log('Created table bank_deposits.');
  }

  if (await colExists('customer_payments', 'deposit_id')) console.log('customer_payments.deposit_id already exists.');
  else if (DRY_RUN) console.log('Would add customer_payments.deposit_id.');
  else { await pool.query('ALTER TABLE customer_payments ADD COLUMN deposit_id BIGINT NULL'); console.log('Added customer_payments.deposit_id.'); }

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
