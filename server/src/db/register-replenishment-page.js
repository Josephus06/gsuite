// Registers Purchasing > Inventory Replenishment (/purchasing/replenishment) in the `pages` table
// -- requirePermission resolves a route to a page before it checks anything, so without this row
// the screen 403s for everyone, System Admin included.
//
// Access: full for System Admins; view + print for every active Purchasing Supervisor
// (users.is_purchasing_supervisor), whose list this is. Anyone else is granted it under Users &
// Permissions like any other page.
//
// Idempotent -- safe to re-run:
//   node src/db/register-replenishment-page.js
const pool = require('../db');
require('dotenv').config();

const ROUTE = '/purchasing/replenishment';
const NAME = 'Inventory Replenishment';
const SIBLING = '/purchase-orders';

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`Page ${ROUTE} already registered (id ${page.id}).`);
  } else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name'];
    const values = [ROUTE, NAME];
    if (has.has('module')) { fields.push('module'); values.push('Purchasing'); }
    if (has.has('sort_order')) {
      const [[sib]] = await pool.query('SELECT sort_order FROM pages WHERE route = ?', [SIBLING]);
      fields.push('sort_order');
      values.push(sib?.sort_order != null ? Number(sib.sort_order) + 1 : 0);
    }
    const [result] = await pool.query(
      `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values,
    );
    page = { id: result.insertId };
    console.log(`Registered ${ROUTE} as "${NAME}" (id ${page.id}).`);
  }

  async function grant(user, full) {
    const [[existing]] = await pool.query(
      'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id]);
    if (existing) {
      await pool.query(
        full
          ? 'UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE, can_print=TRUE WHERE id = ?'
          : 'UPDATE user_page_permissions SET can_view=TRUE, can_print=TRUE WHERE id = ?',
        [existing.id]);
    } else {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print)
         VALUES (?, ?, TRUE, ?, ?, ?, ?, TRUE)`,
        [user.id, page.id, full, full, full, full]);
    }
    console.log(`  + ${user.display_name}: ${full ? 'full access' : 'view + print'}.`);
  }

  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const u of admins) await grant(u, true);
  const [sups] = await pool.query(
    "SELECT id, display_name FROM users WHERE is_purchasing_supervisor = 1 AND is_active = TRUE AND account_type <> 'System Admin'");
  for (const u of sups) await grant(u, false);

  console.log('Done.');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
