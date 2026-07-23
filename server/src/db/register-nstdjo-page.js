// One-off migration: registers Sales > NSTDJO in the `pages` table.
//
// The page had only ever been inserted by hand into a local database -- it was never in
// schema.sql nor in any migration -- so a database built from the repo (production
// included) had no row for it. requirePermission resolves the route to a page before it
// checks anything, so with the row missing the whole module 403s for every user,
// System Admin included.
//
// Admin gets full permissions here, in the same migration that registers the page, so it
// can never be left unreachable. Design Supervisors get their view access separately from
// grant-nstdjo-design-supervisor-access.js, which depends on this row existing.
//
// Idempotent -- safe to re-run:
//   node src/db/register-nstdjo-page.js
const pool = require('../db');
require('dotenv').config();

const ROUTE = '/non-standard-job-orders';
const NAME = 'NSTDJO';

async function main() {
  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`Page ${ROUTE} already registered (id ${page.id}).`);
  } else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name'];
    const values = [ROUTE, NAME];
    if (has.has('module')) { fields.push('module'); values.push('Sales'); }
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
        'UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE WHERE id = ?',
        [existing.id],
      );
    } else {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve)
         VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)`,
        [user.id, page.id],
      );
    }
    console.log(`  + ${user.display_name}: full access.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Registration failed:', err);
  process.exit(1);
});
