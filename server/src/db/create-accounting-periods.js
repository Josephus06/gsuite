// One-off migration: creates the accounting_periods table (period close/lock flags per fiscal-year
// month) and registers the "Manage Accounting Period" page under Accounting. Each month carries five
// close flags -- Close A/R, Close A/P, Close Other GL, Close Non-GL, Close All -- used to lock that
// period. Seeds fiscal years 2024-2026 so the page has content out of the box.
//
//   node src/db/create-accounting-periods.js --dry-run
//   node src/db/create-accounting-periods.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const PAGES = [{ route: '/manage-accounting-period', name: 'Manage Accounting Period', module: 'Accounting' }];
const SEED_YEARS = [2024, 2025, 2026];

async function tableExists(name) { const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]); return rows.length > 0; }

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  if (await tableExists('accounting_periods')) console.log('Table accounting_periods already exists.');
  else if (DRY_RUN) console.log('Would create table accounting_periods.');
  else {
    await pool.query(`
CREATE TABLE accounting_periods (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    fiscal_year INT NOT NULL,
    period_month INT NOT NULL,
    close_ar TINYINT NOT NULL DEFAULT 0,
    close_ap TINYINT NOT NULL DEFAULT 0,
    close_other_gl TINYINT NOT NULL DEFAULT 0,
    close_non_gl TINYINT NOT NULL DEFAULT 0,
    close_all TINYINT NOT NULL DEFAULT 0,
    updated_at DATETIME NULL,
    updated_by_user_id BIGINT NULL,
    UNIQUE KEY uq_period (fiscal_year, period_month)
)`);
    console.log('Created table accounting_periods.');
    for (const fy of SEED_YEARS) {
      for (let m = 1; m <= 12; m += 1) {
        await pool.query('INSERT IGNORE INTO accounting_periods (fiscal_year, period_month) VALUES (?, ?)', [fy, m]);
      }
    }
    console.log(`Seeded fiscal years ${SEED_YEARS.join(', ')}.`);
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
