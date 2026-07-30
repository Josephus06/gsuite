// One-off migration: creates the Fund Transfer (FT-####) table and registers its page under
// Accounting. A Fund Transfer moves an amount from one bank account to another. GL: DR the To
// account / CR the From account. No lines -- it's a single from -> to move.
//
//   node src/db/create-fund-transfers.js --dry-run
//   node src/db/create-fund-transfers.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const PAGES = [{ route: '/fund-transfers', name: 'Fund Transfer', module: 'Accounting' }];

async function tableExists(name) { const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]); return rows.length > 0; }

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  if (await tableExists('fund_transfers')) console.log('Table fund_transfers already exists.');
  else if (DRY_RUN) console.log('Would create table fund_transfers.');
  else {
    await pool.query(`
CREATE TABLE fund_transfers (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    ft_no VARCHAR(40) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    from_account_id BIGINT NULL,
    to_account_id BIGINT NULL,
    amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    memo VARCHAR(1000) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_by_user_id BIGINT NULL,
    voided_at DATETIME NULL,
    INDEX idx_ft_date (date_created),
    INDEX idx_ft_status (status)
)`);
    console.log('Created table fund_transfers.');
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
