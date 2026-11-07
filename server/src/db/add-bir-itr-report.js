// BIR Reports > Income Tax Return (asked 2026-11-07): the quarterly corporate income tax return,
// BIR Form 1702Q, computed from the Income Statement (routes/birReports.js GET /itr).
//
//   /reports/bir-itr         "Income Tax Return (1702Q)"
//   /reports/bir-tax-return  "Tax Return" (added the same day, after Odoo's Tax Return page: 2550Q, SAWT & QAP,
//                            tax by account, generic tax report -- routes/birTaxReturn.js)
//
// System Admins get View and Print; so does everyone who can already view VAT Computation -- the
// people preparing the VAT return prepare this one too. Grant others from Users & Permissions.
// Idempotent.
//   node src/db/add-bir-itr-report.js --dry-run
//   node src/db/add-bir-itr-report.js
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const PAGES = [['/reports/bir-itr', 'Income Tax Return (1702Q)'], ['/reports/bir-tax-return', 'Tax Return']];

(async () => {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY ? ' -- DRY RUN' : ''}\n`);
  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  const hasModule = cols.some((c) => c.Field === 'module');
  const [permCols] = await pool.query('SHOW COLUMNS FROM user_page_permissions');
  const hasPrint = permCols.some((c) => c.Field === 'can_print');

  for (const [ROUTE, NAME] of PAGES) {
  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) console.log(`= ${ROUTE} already registered (id ${page.id})`);
  else if (DRY) console.log(`~ would register ${ROUTE} "${NAME}"`);
  else {
    const [r] = await pool.query(
      `INSERT INTO pages (route, name${hasModule ? ', module' : ''}) VALUES (?, ?${hasModule ? ', ?' : ''})`,
      hasModule ? [ROUTE, NAME, 'BIR Reports'] : [ROUTE, NAME]);
    page = { id: r.insertId };
    console.log(`+ registered ${ROUTE} "${NAME}" (id ${page.id})`);
  }

  const [users] = await pool.query(
    `SELECT DISTINCT u.id, u.display_name FROM users u
      WHERE u.is_active = 1 AND (u.account_type = 'System Admin' OR u.id IN (
        SELECT upp.user_id FROM user_page_permissions upp JOIN pages p ON p.id = upp.page_id
         WHERE p.route = '/reports/bir-vat' AND upp.can_view = 1))
      ORDER BY u.id`);
  for (const u of users) {
    if (DRY || !page) { console.log(`  ~ ${u.display_name}`); continue; }
    const [[ex]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [u.id, page.id]);
    if (ex) await pool.query(`UPDATE user_page_permissions SET can_view = 1${hasPrint ? ', can_print = 1' : ''} WHERE id = ?`, [ex.id]);
    else {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view${hasPrint ? ', can_print' : ''}) VALUES (?, ?, 1${hasPrint ? ', 1' : ''})`,
        [u.id, page.id]);
    }
    console.log(`  + ${u.display_name}`);
  }
  console.log(`${users.length} user(s) can view and print ${NAME}.\n`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
