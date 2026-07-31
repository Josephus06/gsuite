// One-off migration: registers the Process Flow page (/process-flow).
//
// Process Flow is the clickable order-to-cash chart -- a guide to the other modules, not
// a data module of its own. It has no tables and no API: the chart and its per-step
// manuals live in client/src/data/processFlow.js. All this migration does is create the
// `pages` row so the nav visibility check and ProtectedRoute let people in.
//
// System Admins get full access (same as every other page migration here). Every other
// active user gets can_view only -- a manual nobody can open is useless, and there is
// nothing behind this page to add, edit, or delete. Pass --admins-only to skip that and
// hand out view rights yourself from Users & Permissions instead.
//
//   node src/db/create-process-flow-page.js --dry-run
//   node src/db/create-process-flow-page.js
//   node src/db/create-process-flow-page.js --admins-only
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const ADMINS_ONLY = process.argv.includes('--admins-only');
const PAGE = { route: '/process-flow', name: 'Process Flow', module: 'Dashboard' };

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [PAGE.route]);
  if (page) {
    console.log(`Page ${PAGE.route} already registered (id ${page.id}).`);
  } else if (DRY_RUN) {
    console.log(`Would register ${PAGE.route} as "${PAGE.name}".`);
  } else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name'];
    const values = [PAGE.route, PAGE.name];
    if (has.has('module')) { fields.push('module'); values.push(PAGE.module); }
    const [result] = await pool.query(
      `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
      values
    );
    page = { id: result.insertId };
    console.log(`Registered ${PAGE.route} as "${PAGE.name}" (id ${page.id}).`);
  }
  // On a dry run against a database where the page does not exist yet there is no id to
  // look permissions up by -- carry on with a null id so the report still says who would
  // be granted what, instead of stopping at "would register" and looking like a no-op.
  if (!page && !DRY_RUN) { await pool.end(); return; }
  const pageId = page ? page.id : null;

  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE"
  );
  console.log('');
  for (const user of admins) {
    const [[existing]] = pageId === null
      ? [[undefined]]
      : await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, pageId]);
    if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get full access.`); continue; }
    if (existing) {
      await pool.query(
        'UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE WHERE id = ?',
        [existing.id]
      );
    } else {
      await pool.query(
        'INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve) VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)',
        [user.id, pageId]
      );
    }
    console.log(`  + ${user.display_name}: full access.`);
  }

  if (ADMINS_ONLY) {
    console.log('\n--admins-only: skipping the read-only grant for everyone else.');
    await pool.end();
    return;
  }

  const adminIds = new Set(admins.map((a) => a.id));
  const [others] = await pool.query('SELECT id, display_name FROM users WHERE is_active = TRUE');
  const targets = others.filter((u) => !adminIds.has(u.id));
  console.log(`\nRead-only access for ${targets.length} other active user(s):`);
  let granted = 0;
  let skipped = 0;
  for (const user of targets) {
    const [[existing]] = pageId === null
      ? [[undefined]]
      : await pool.query('SELECT id, can_view FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, pageId]);
    if (existing?.can_view) { skipped += 1; continue; }
    if (DRY_RUN) { granted += 1; continue; }
    if (existing) await pool.query('UPDATE user_page_permissions SET can_view = TRUE WHERE id = ?', [existing.id]);
    else {
      await pool.query(
        'INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve) VALUES (?, ?, TRUE, FALSE, FALSE, FALSE, FALSE)',
        [user.id, pageId]
      );
    }
    granted += 1;
  }
  console.log(`  ${DRY_RUN ? 'would grant' : 'granted'} can_view to ${granted}; ${skipped} already had it.`);

  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
