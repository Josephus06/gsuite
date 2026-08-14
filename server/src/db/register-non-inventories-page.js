// Registers Master Lists > Non-Inventories in the `pages` table.
//
// Non-Inventory items used to be a four-column tab inside Lookups, so they had no page row of
// their own. They are now a full item master list at /non-inventories, matching live's screen,
// and requirePermission resolves a route to a page before it checks anything -- without this row
// the module 403s for everyone, System Admin included.
//
// View access is mirrored from Service Items, the sibling list backed by the same `inventories`
// table: anyone already trusted with one item master list should not have to wait for an admin
// to tick boxes before seeing the other.
//
// Idempotent -- safe to re-run:
//   node src/db/register-non-inventories-page.js
const pool = require('../db');
require('dotenv').config();

const ROUTE = '/non-inventories';
const NAME = 'Non-Inventories';
const SIBLING = '/service-items';

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`Page ${ROUTE} already registered (id ${page.id}).`);
  } else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name'];
    const values = [ROUTE, NAME];
    if (has.has('module')) { fields.push('module'); values.push('Master Lists'); }
    // Slot it right after Service Items rather than at the end of the table.
    if (has.has('sort_order')) {
      const [[sib]] = await pool.query('SELECT sort_order FROM pages WHERE route = ?', [SIBLING]);
      fields.push('sort_order');
      values.push(sib?.sort_order != null ? Number(sib.sort_order) + 1 : 0);
    }
    const [result] = await pool.query(
      `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
      values,
    );
    page = { id: result.insertId };
    console.log(`Registered ${ROUTE} as "${NAME}" (id ${page.id}).`);
  }

  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE",
  );
  for (const user of admins) {
    const [[existing]] = await pool.query(
      'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id],
    );
    if (existing) {
      await pool.query(
        'UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE, can_print=TRUE WHERE id = ?',
        [existing.id],
      );
    } else {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print)
         VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE)`,
        [user.id, page.id],
      );
    }
    console.log(`  + ${user.display_name}: full access.`);
  }

  const [[sibPage]] = await pool.query('SELECT id FROM pages WHERE route = ?', [SIBLING]);
  if (sibPage) {
    const [r] = await pool.query(
      `INSERT INTO user_page_permissions (user_id, page_id, can_view)
       SELECT upp.user_id, ?, TRUE FROM user_page_permissions upp
        WHERE upp.page_id = ? AND upp.can_view = TRUE
          AND NOT EXISTS (SELECT 1 FROM user_page_permissions x WHERE x.user_id = upp.user_id AND x.page_id = ?)`,
      [page.id, sibPage.id, page.id],
    );
    console.log(`\nMirrored view access from Service Items to ${r.affectedRows} more user(s).`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
