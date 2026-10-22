// Accounting > Reports > Sales Orders (Commission) and Invoices (Commission) (routes/commissionReports.js,
// asked 2026-10-22): registers the two pages and gives System Admins View and Print. Grant Accounting
// from Users & Permissions afterwards.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-commission-report-pages.js --dry-run
//   node src/db/add-commission-report-pages.js
require('dotenv').config();
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const MODULE = 'Accounting';
const PAGES = [
  { route: '/reports/commission-sales-orders', name: 'Sales Orders (Commission)' },
  { route: '/reports/commission-invoices', name: 'Invoices (Commission)' },
];

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY ? ' -- DRY RUN' : ''}\n`);
  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  const hasModule = cols.some((c) => c.Field === 'module');
  const [permCols] = await pool.query('SHOW COLUMNS FROM user_page_permissions');
  const hasPrint = permCols.some((c) => c.Field === 'can_print');
  const [admins] = await pool.query("SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = 1");
  for (const p of PAGES) {
    let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [p.route]);
    if (page) console.log(`= ${p.route} already registered (id ${page.id})`);
    else if (DRY) console.log(`~ would register ${p.route} "${p.name}"`);
    else {
      const [r] = await pool.query(
        `INSERT INTO pages (route, name${hasModule ? ', module' : ''}) VALUES (?, ?${hasModule ? ', ?' : ''})`,
        hasModule ? [p.route, p.name, MODULE] : [p.route, p.name]);
      page = { id: r.insertId };
      console.log(`+ registered ${p.route} "${p.name}" (id ${page.id})`);
    }
    if (!page) continue;
    for (const u of admins) {
      const [[ex]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [u.id, page.id]);
      if (DRY) { console.log(`  ~ ${u.display_name}`); continue; }
      if (ex) await pool.query(`UPDATE user_page_permissions SET can_view = 1${hasPrint ? ', can_print = 1' : ''} WHERE id = ?`, [ex.id]);
      else await pool.query(`INSERT INTO user_page_permissions (user_id, page_id, can_view${hasPrint ? ', can_print' : ''}) VALUES (?, ?, 1${hasPrint ? ', 1' : ''})`, [u.id, page.id]);
      console.log(`  + ${u.display_name}`);
    }
  }
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
