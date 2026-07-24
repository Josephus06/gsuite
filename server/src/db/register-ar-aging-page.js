// One-off migration: registers Accounting > Reports > AR Aging in the `pages` table.
//
// requirePermission resolves a route to a page before it checks anything, so without this
// row the whole report 403s for every user including System Admin. Admins are granted full
// access in the same migration so it can never be left unreachable.
//
// Idempotent -- safe to re-run:
//   node src/db/register-ar-aging-page.js --dry-run   (report only)
//   node src/db/register-ar-aging-page.js             (apply)
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const ROUTE = '/reports/ar-aging';
const NAME = 'AR Aging';

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`Page ${ROUTE} already registered (id ${page.id}).`);
  } else if (DRY_RUN) {
    console.log(`Would register ${ROUTE} as "${NAME}".`);
  } else {
    // Match the shape the other /reports/* rows use (no module column in this schema),
    // slotting sort_order just after the four GL reports.
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name'];
    const values = [ROUTE, NAME];
    if (has.has('sort_order')) { fields.push('sort_order'); values.push(37); }
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
  if (!page) {
    console.log(`Would grant full access to ${admins.length} admin(s) once the page row exists.`);
  } else {
    for (const user of admins) {
      const [[existing]] = await pool.query(
        'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id],
      );
      if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get full access.`); continue; }
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
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Registration failed:', err);
  process.exit(1);
});
