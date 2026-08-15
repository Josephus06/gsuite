// Registers Master Lists > Website Products.
//
// requirePermission resolves a route to a page before it checks anything, so without this row the
// whole module 403s for everyone, System Admin included.
//
// can_approve on this page is what allows PUBLISHING a product -- the step that puts a price in
// front of a customer. It is kept apart from can_edit on purpose: someone can be trusted to
// correct a default size without also being the person who decides the catalogue is ready to
// quote from. Only System Admins get it here; grant it deliberately to whoever owns that call.
//
// Idempotent -- safe to re-run:
//   node src/db/register-web-products-page.js
const pool = require('../db');
require('dotenv').config();

const ROUTE = '/web-products';
const NAME = 'Website Products';

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
    if (has.has('sort_order')) {
      const [[sib]] = await pool.query("SELECT sort_order FROM pages WHERE route = '/non-inventories'");
      fields.push('sort_order');
      values.push(sib?.sort_order != null ? Number(sib.sort_order) + 1 : 0);
    }
    const [result] = await pool.query(
      `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values
    );
    page = { id: result.insertId };
    console.log(`Registered ${ROUTE} as "${NAME}" (id ${page.id}).`);
  }

  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE"
  );
  for (const user of admins) {
    const [[existing]] = await pool.query(
      'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id]
    );
    if (existing) {
      await pool.query(
        'UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE WHERE id = ?',
        [existing.id]
      );
    } else {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print)
         VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE)`, [user.id, page.id]
      );
    }
    console.log(`  + ${user.display_name}: full access (including publish).`);
  }

  const [[n]] = await pool.query('SELECT COUNT(*) AS n, SUM(is_published) AS pub FROM web_products');
  console.log(`\nweb_products: ${n.n} total, ${Number(n.pub || 0)} published.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
