// Managers Dashboard app (routes/managerDashboard.js, /api/manager/*): registers its page
// and gives System Admins view. Grant each manager View on it from Users & Permissions afterwards --
// only they can call the API.
//
// Idempotent. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/add-manager-dashboard-page.js --dry-run
//   node src/db/add-manager-dashboard-page.js
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const ROUTE = '/manager-dashboard';
const NAME = 'Managers Dashboard';
const MODULE = 'Dashboard';

async function registerPage() {
  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (existing) { console.log(`Page ${ROUTE} already registered (id ${existing.id}).`); return existing.id; }
  if (DRY_RUN) { console.log(`Would register ${ROUTE} as "${NAME}".`); return null; }
  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  const has = new Set(cols.map((c) => c.Field));
  const fields = ['route', 'name'];
  const values = [ROUTE, NAME];
  if (has.has('module')) { fields.push('module'); values.push(MODULE); }
  const [result] = await pool.query(
    `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values);
  console.log(`Registered ${ROUTE} as "${NAME}" (id ${result.insertId}).`);
  return result.insertId;
}

async function grantAdmins(pageId) {
  if (!pageId) return;
  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const user of admins) {
    const [[existing]] = await pool.query(
      'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, pageId]);
    if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get view.`); continue; }
    if (existing) await pool.query('UPDATE user_page_permissions SET can_view = TRUE WHERE id = ?', [existing.id]);
    else await pool.query('INSERT INTO user_page_permissions (user_id, page_id, can_view) VALUES (?, ?, TRUE)', [user.id, pageId]);
    console.log(`  + ${user.display_name}: view.`);
  }
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- nothing will be written.\n' : 'APPLYING changes.\n');
  await grantAdmins(await registerPage());
  await pool.end();
}

main().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
