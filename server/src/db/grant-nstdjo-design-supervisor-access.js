// One-off script: gives every Design Supervisor view access to the NSTDJO page.
//
// Forwarding a Non-Standard Job Order moves its Sub Status to "For Design Supervisor",
// which puts it in the design queue -- but a supervisor with no user_page_permissions row
// for this page is refused by requirePermission before that filter ever runs, so the
// queue would be invisible to the one person who needs to act on it.
//
// can_view only, deliberately: assigning an artist is gated on the is_design_supervisor
// role flag itself (see PUT /:id/assign-artist), not on can_edit, so a supervisor needs
// no write rights here. Withholding can_edit also keeps Forward/Cancel -- Sales actions --
// out of their hands.
//
// Idempotent -- safe to re-run:
//   node src/db/grant-nstdjo-design-supervisor-access.js
const pool = require('../db');
require('dotenv').config();

const ROUTE = '/non-standard-job-orders';

async function main() {
  const [[page]] = await pool.query('SELECT id, name FROM pages WHERE route = ?', [ROUTE]);
  if (!page) throw new Error(`No pages row for ${ROUTE} -- run the schema migration first.`);
  console.log(`Page: ${page.name} (id ${page.id})`);

  const [supervisors] = await pool.query(
    'SELECT id, username, display_name FROM users WHERE is_design_supervisor = TRUE AND is_active = TRUE',
  );
  if (!supervisors.length) { console.log('No active design supervisors.'); await pool.end(); return; }

  for (const user of supervisors) {
    const [[existing]] = await pool.query(
      'SELECT id, can_view FROM user_page_permissions WHERE user_id = ? AND page_id = ?',
      [user.id, page.id],
    );
    if (existing?.can_view) { console.log(`  = ${user.display_name} already has view access.`); continue; }
    if (existing) {
      await pool.query('UPDATE user_page_permissions SET can_view = TRUE WHERE id = ?', [existing.id]);
      console.log(`  + ${user.display_name}: enabled can_view on existing row.`);
    } else {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve)
         VALUES (?, ?, TRUE, FALSE, FALSE, FALSE, FALSE)`,
        [user.id, page.id],
      );
      console.log(`  + ${user.display_name}: granted can_view.`);
    }
  }

  const [summary] = await pool.query(
    `SELECT u.display_name, u.account_type, upp.can_view, upp.can_edit
       FROM users u
       LEFT JOIN user_page_permissions upp ON upp.user_id = u.id AND upp.page_id = ?
      WHERE u.is_design_supervisor = TRUE AND u.is_active = TRUE`,
    [page.id],
  );
  console.log('\nDesign Supervisor access to NSTDJO:');
  console.table(summary);

  await pool.end();
}

main().catch((err) => {
  console.error('Grant failed:', err);
  process.exit(1);
});
