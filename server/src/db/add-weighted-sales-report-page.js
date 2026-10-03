// Registers Sales > Weighted Sales per Month (/reports/weighted-sales). Its view/print grant is
// carried over from whoever can view Sales Orders; which orders each person sees inside it is the
// route's own rule (SBU head / supervisor / account officer), not this grant. System Admins get
// every action.
//
// Idempotent. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/add-weighted-sales-report-page.js
const pool = require('../db');
require('dotenv').config();

const ROUTE = '/reports/weighted-sales';
const SOURCE = '/sales-orders';

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);
  const [[source]] = await pool.query('SELECT id FROM pages WHERE route = ?', [SOURCE]);
  if (!source) throw new Error(`${SOURCE} is not registered, so its grants cannot be copied.`);

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) console.log(`Page ${ROUTE}: already registered (id ${page.id}).`);
  else {
    const [r] = await pool.query('INSERT INTO pages (route, name) VALUES (?, ?)', [ROUTE, 'Weighted Sales per Month']);
    page = { id: r.insertId };
    console.log(`Page ${ROUTE}: registered (id ${page.id}).`);
  }

  const [upp] = await pool.query(
    `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_print)
     SELECT src.user_id, ?, TRUE, TRUE FROM user_page_permissions src
      WHERE src.page_id = ? AND src.can_view = TRUE
        AND NOT EXISTS (SELECT 1 FROM (SELECT user_id FROM user_page_permissions WHERE page_id = ?) e WHERE e.user_id = src.user_id)`,
    [page.id, source.id, page.id]);
  console.log(`  user_page_permissions: ${upp.affectedRows} view grant(s) carried over from ${SOURCE}.`);

  const [atp] = await pool.query(
    `INSERT INTO account_type_permissions (account_type, page_id, can_view, can_print, updated_at)
     SELECT src.account_type, ?, TRUE, TRUE, NOW() FROM account_type_permissions src
      WHERE src.page_id = ? AND src.can_view = TRUE
        AND NOT EXISTS (SELECT 1 FROM (SELECT account_type FROM account_type_permissions WHERE page_id = ?) e WHERE e.account_type = src.account_type)`,
    [page.id, source.id, page.id]);
  console.log(`  account_type_permissions: ${atp.affectedRows} template row(s) carried over.`);

  await pool.query(
    `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print)
     SELECT u.id, ?, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE FROM users u
      WHERE u.account_type = 'System Admin'
        AND NOT EXISTS (SELECT 1 FROM (SELECT user_id FROM user_page_permissions WHERE page_id = ?) e WHERE e.user_id = u.id)`,
    [page.id, page.id]);
  await pool.end();
}
main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
