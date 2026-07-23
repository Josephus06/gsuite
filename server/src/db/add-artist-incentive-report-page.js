// One-off migration: registers Design > Artist Incentive Report and grants access.
//
// Admin gets full permissions in the same migration that registers the page, so the page
// is never left unreachable. Design Supervisors get view access too -- the report is about
// their artists' output, so it belongs to them as much as to management.
//
// Idempotent -- safe to re-run:
//   node src/db/add-artist-incentive-report-page.js
const pool = require('../db');
require('dotenv').config();

const ROUTE = '/reports/artist-incentive';
const NAME = 'Artist Incentive Report';

async function main() {
  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`Page ${ROUTE} already registered (id ${page.id}).`);
  } else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name'];
    const values = [ROUTE, NAME];
    // `module`/`sort_order` exist on some builds of this table -- only set what's there.
    if (has.has('module')) { fields.push('module'); values.push('Design'); }
    const [result] = await pool.query(
      `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
      values,
    );
    page = { id: result.insertId };
    console.log(`Registered ${ROUTE} (id ${page.id}).`);
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

  const [supervisors] = await pool.query(
    "SELECT id, display_name FROM users WHERE is_design_supervisor = TRUE AND is_active = TRUE AND account_type <> 'System Admin'",
  );
  for (const user of supervisors) {
    const [[existing]] = await pool.query(
      'SELECT id, can_view FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id],
    );
    if (existing?.can_view) { console.log(`  = ${user.display_name} already has view access.`); continue; }
    if (existing) await pool.query('UPDATE user_page_permissions SET can_view = TRUE WHERE id = ?', [existing.id]);
    else {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve)
         VALUES (?, ?, TRUE, FALSE, FALSE, FALSE, FALSE)`,
        [user.id, page.id],
      );
    }
    console.log(`  + ${user.display_name}: view access.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
