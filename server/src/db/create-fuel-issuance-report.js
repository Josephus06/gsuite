// One-off migration (2026-11-23): registers Reports > Fuel Issuance (routes/fuelIssuanceReport.js) as
// its own permission page, full access for every System Admin. Grant it to Audit in Users & Permissions.
//
//   node src/db/create-fuel-issuance-report.js [--dry-run]
//
// The droplet, office and SM boxes replicate: run on ONE box (the droplet). Railway: run it there too.
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const PAGE = { route: '/reports/fuel-issuance', name: 'Fuel Issuance Report', module: 'Reports' };

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`DB: ${db}${DRY_RUN ? ' -- DRY RUN' : ''}`);
  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [PAGE.route]);
  if (page) console.log(`  = page ${PAGE.route} already registered (id ${page.id})`);
  else if (DRY_RUN) console.log(`  ~ would register ${PAGE.route}`);
  else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name']; const values = [PAGE.route, PAGE.name];
    if (has.has('module')) { fields.push('module'); values.push(PAGE.module); }
    const [r] = await pool.query(`INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values);
    page = { id: r.insertId };
    console.log(`  + registered ${PAGE.route} (id ${page.id})`);
  }
  if (!page || DRY_RUN) return;
  const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const u of admins) {
    const [[existing]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [u.id, page.id]);
    if (existing) await pool.query('UPDATE user_page_permissions SET can_view=TRUE, can_print=TRUE WHERE id = ?', [existing.id]);
    else await pool.query('INSERT INTO user_page_permissions (user_id, page_id, can_view, can_print) VALUES (?, ?, TRUE, TRUE)', [u.id, page.id]);
  }
  console.log(`  + view / print for ${admins.length} System Admin(s)`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
