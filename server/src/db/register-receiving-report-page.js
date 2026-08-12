// Registers Purchasing > Receiving Report in the `pages` table.
//
// Receiving Reports already existed as documents -- they are created against a Purchase
// Order and viewed through it -- but there was no module listing them, so there was no way
// to answer "what did we receive this month" without opening POs one at a time. This gives
// the list its own page row, and therefore its own permission, separate from Purchase Orders.
//
// requirePermission resolves a route to a page before it checks anything, so without this row
// the whole module 403s for every user, System Admin included.
//
// Idempotent -- safe to re-run:
//   node src/db/register-receiving-report-page.js
const pool = require('../db');
require('dotenv').config();

const ROUTE = '/receiving-reports';
const NAME = 'Receiving Report';

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
    if (has.has('module')) { fields.push('module'); values.push('Purchasing'); }
    // Slot it right after Purchase Orders rather than at the end of the table.
    if (has.has('sort_order')) {
      const [[po]] = await pool.query("SELECT sort_order FROM pages WHERE route = '/purchase-orders'");
      fields.push('sort_order');
      values.push(po?.sort_order != null ? Number(po.sort_order) + 1 : 0);
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

  // Anyone who can already see Purchase Orders can see the reports those POs produced --
  // without this the module would be invisible to the buyers who actually use it until an
  // admin ticked every box by hand.
  const [[poPage]] = await pool.query("SELECT id FROM pages WHERE route = '/purchase-orders'");
  if (poPage) {
    const [r] = await pool.query(
      `INSERT INTO user_page_permissions (user_id, page_id, can_view)
       SELECT upp.user_id, ?, TRUE FROM user_page_permissions upp
        WHERE upp.page_id = ? AND upp.can_view = TRUE
          AND NOT EXISTS (SELECT 1 FROM user_page_permissions x WHERE x.user_id = upp.user_id AND x.page_id = ?)`,
      [page.id, poPage.id, page.id],
    );
    console.log(`\nMirrored view access from Purchase Orders to ${r.affectedRows} more user(s).`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
