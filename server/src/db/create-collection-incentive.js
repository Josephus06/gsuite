// Treasury > Collection Incentive (routes/collectionIncentive.js): the per-year set-up table, the
// permission page, and System Admins given view + edit (edit = change the set-up). Grant Treasury
// from Users & Permissions afterwards.
//
// collection_incentive_settings, one row per year: the target % of each aging bucket (adding up to
// 100%), the monthly target, the incentive rate (0.1%) and the qualifier (90% of the monthly
// target). Per year so changing next year's targets does not rewrite this year's reports. Seeded
// with Treasury's workbook figures for 2026.
//
// Idempotent. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/create-collection-incentive.js --dry-run
//   node src/db/create-collection-incentive.js
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const ROUTE = '/treasury/collection-incentive';
const NAME = 'Collection Incentive';
const MODULE = 'Treasury';

async function createTable() {
  const [exists] = await pool.query("SHOW TABLES LIKE 'collection_incentive_settings'");
  if (exists.length) { console.log('= collection_incentive_settings already exists'); return; }
  if (DRY_RUN) { console.log('~ would create collection_incentive_settings'); return; }
  await pool.query(`CREATE TABLE collection_incentive_settings (
      year SMALLINT UNSIGNED PRIMARY KEY,
      target_current DECIMAL(9,6) NOT NULL,
      target_1_30 DECIMAL(9,6) NOT NULL,
      target_31_60 DECIMAL(9,6) NOT NULL,
      target_61_90 DECIMAL(9,6) NOT NULL,
      target_over_90 DECIMAL(9,6) NOT NULL,
      monthly_target DECIMAL(15,2) NOT NULL,
      incentive_rate DECIMAL(9,6) NOT NULL DEFAULT 0.001000,
      qualifier_pct DECIMAL(9,6) NOT NULL DEFAULT 0.900000,
      updated_by_user_id INT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  console.log('+ created collection_incentive_settings');
  await pool.query(
    `INSERT IGNORE INTO collection_incentive_settings
       (year, target_current, target_1_30, target_31_60, target_61_90, target_over_90, monthly_target, incentive_rate, qualifier_pct)
     VALUES (2026, 0.295, 0.38, 0.17, 0.06, 0.095, 10000000, 0.001, 0.9)`);
  console.log('+ seeded 2026 with the workbook figures');
}

async function registerPage() {
  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (existing) { console.log(`= page ${ROUTE} already registered (id ${existing.id})`); return existing.id; }
  if (DRY_RUN) { console.log(`~ would register ${ROUTE} as "${NAME}"`); return null; }
  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  const has = new Set(cols.map((c) => c.Field));
  const fields = ['route', 'name'];
  const values = [ROUTE, NAME];
  if (has.has('module')) { fields.push('module'); values.push(MODULE); }
  const [result] = await pool.query(
    `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values);
  console.log(`+ registered ${ROUTE} as "${NAME}" (id ${result.insertId})`);
  return result.insertId;
}

async function grantAdmins(pageId) {
  if (!pageId) return;
  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const user of admins) {
    const [[existing]] = await pool.query(
      'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, pageId]);
    if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get view + edit`); continue; }
    if (existing) await pool.query('UPDATE user_page_permissions SET can_view = TRUE, can_edit = TRUE WHERE id = ?', [existing.id]);
    else await pool.query('INSERT INTO user_page_permissions (user_id, page_id, can_view, can_edit) VALUES (?, ?, TRUE, TRUE)', [user.id, pageId]);
    console.log(`  + ${user.display_name}: view + edit`);
  }
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- nothing will be written.\n' : 'APPLYING changes.\n');
  await createTable();
  await grantAdmins(await registerPage());
  await pool.end();
}

main().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
