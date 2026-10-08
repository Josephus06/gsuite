// Registers Accounting > Statement of Account (2026-10-08) and grants access. Idempotent.
//
// System Admins get full access. Anyone who can already view AR Aging or AP Aging gets view access:
// the statement shows a single customer's or vendor's open items -- the same figures those reports
// show for everyone -- so it is not a new right, only a new way to read one.
//
//   node src/db/add-statement-of-account-page.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const ROUTE = '/statement-of-accounts';
const NAME = 'Statement of Account';

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`Page ${ROUTE} already registered (id ${page.id}).`);
  } else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name']; const values = [ROUTE, NAME];
    if (has.has('module')) { fields.push('module'); values.push('Accounting'); }
    const [r] = await pool.query(`INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values);
    page = { id: r.insertId };
    console.log(`Registered ${ROUTE} (id ${page.id}).`);
  }
  const grant = async (userId, full) => {
    const [[ex]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [userId, page.id]);
    if (ex) {
      await pool.query(full
        ? 'UPDATE user_page_permissions SET can_view = TRUE, can_add = TRUE, can_edit = TRUE, can_delete = TRUE, can_approve = TRUE WHERE id = ?'
        : 'UPDATE user_page_permissions SET can_view = TRUE WHERE id = ?', [ex.id]);
    } else {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve) VALUES (?, ?, TRUE, ?, ?, ?, ?)`,
        [userId, page.id, full, full, full, full]);
    }
  };
  const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const u of admins) await grant(u.id, true);
  const [viewers] = await pool.query(
    `SELECT DISTINCT upp.user_id AS id FROM user_page_permissions upp JOIN pages p ON p.id = upp.page_id
       JOIN users u ON u.id = upp.user_id AND u.is_active = TRUE AND u.account_type <> 'System Admin'
      WHERE p.route IN ('/reports/ar-aging', '/reports/ap-aging') AND upp.can_view = TRUE`);
  for (const u of viewers) await grant(u.id, false);
  console.log(`Access: ${admins.length} System Admin(s) full, ${viewers.length} AR/AP Aging viewer(s) view.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
