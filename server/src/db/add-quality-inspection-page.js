// Gives Quality Inspection a permission row of its own instead of borrowing Production's.
//
// qualityInspections.js was written with `const ROUTE = '/production'`, so its rights meant the
// wrong things:
//
//   "may I inspect a build"        was really  can_edit on Production
//   "may I see the QI list"        was really  can_view on Production
//   "may I cancel an inspection"   was really  can_edit on Production
//
// Inspecting is not editing production. A QC inspector records what passed and what was rejected;
// they do not schedule jobs, send them for revision or raise rework -- yet can_edit on Production
// was the single switch for all of that, so letting someone inspect handed them the whole floor.
// It also meant Quality Inspection could not be found in the permission grid: there was no row to
// search for.
//
// The actions now mean what they say:
//
//   /quality-inspections  can_view   see the Quality Inspection list and open one
//                         can_add    CREATE a quality inspection -- do the inspection
//                                    (was can_edit on Production)
//                         can_edit   cancel a saved one, which reverses the inspected quantity
//                                    (also was can_edit on Production)
//
// can_delete, can_approve and can_print stay FALSE: nothing in this build deletes, approves or
// prints a Quality Inspection, so granting them would be theatre.
//
// WHAT STAYS ON PRODUCTION: GET /quality-inspections/for-job-order/:id, which fills the modal
// opened from the Job Order's Production screen. An endpoint is gated by the PAGE IT SERVES, not
// by the entity it returns -- gating that one here would blank a panel in the middle of the
// Production screen for anyone without QI rights.
//
// NOBODY LOSES ACCESS. Existing Production grants are copied across: can_view becomes can_view,
// and can_edit -- which is what let someone inspect and cancel -- becomes BOTH can_add and
// can_edit. A migration that quietly stopped QC from inspecting would be a worse bug than the one
// it fixes.
//
// IDEMPOTENT: safe to re-run. Existing rows are left alone rather than overwritten, so a re-run
// cannot undo permissions someone has since adjusted by hand. Run it twice -- the second run must
// report 0 carried over.
//
// RUN THIS BEFORE THE CODE THAT NEEDS IT REACHES THE BOX. requirePermission answers 500, not 403,
// when the page row is missing, so every Quality Inspection endpoint faults until this has run.
//
//   node src/db/add-quality-inspection-page.js
//   node src/db/add-quality-inspection-page.js --dry-run
require('dotenv').config();
const pool = require('../db');

const SOURCE = '/production';
const TARGET = { route: '/quality-inspections', name: 'Quality Inspection' };
const dryRun = process.argv.includes('--dry-run');

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${dryRun ? '  (DRY RUN)' : ''}\n`);

  const [[source]] = await pool.query('SELECT id FROM pages WHERE route = ?', [SOURCE]);
  if (!source) throw new Error(`${SOURCE} is not registered, so its grants cannot be copied.`);

  const hasViewAll = await columnExists('user_page_permissions', 'can_view_all');
  const hasUpdate = await columnExists('user_page_permissions', 'can_update');
  // Both columns arrived after this build's first permission rows, so neither can be assumed --
  // an install that has not run their migrations yet must still be able to run this one.
  const extraCols = [hasViewAll ? 'can_view_all' : null, hasUpdate ? 'can_update' : null].filter(Boolean);
  const extraSel = extraCols.map((c) => `src.${c}`);

  // Counted before anything is written so the dry run and the real run report the same numbers,
  // and so there is one chance to see the scale of the change before it happens.
  const [[willCarry]] = await pool.query(
    `SELECT COUNT(*) AS n FROM user_page_permissions src
      WHERE src.page_id = ? AND (src.can_view = TRUE OR src.can_edit = TRUE)`, [source.id]);
  const [[canInspectNow]] = await pool.query(
    'SELECT COUNT(*) AS n FROM user_page_permissions WHERE page_id = ? AND can_edit = TRUE', [source.id]);
  console.log(`${SOURCE} today: ${willCarry.n} user(s) with view or edit, of whom ${canInspectNow.n}`);
  console.log('can inspect (can_edit). Those become can_add on the new page.\n');

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [TARGET.route]);
  if (page) {
    console.log(`Page ${TARGET.route}: already registered (id ${page.id}).`);
  } else if (dryRun) {
    console.log(`Page ${TARGET.route}: would be registered as "${TARGET.name}".`);
  } else {
    // Placed next to Production in the permission grid rather than at sort_order 0, where a new
    // page floats to the top of a list nobody expects it at the top of.
    const [[sib]] = await pool.query('SELECT sort_order FROM pages WHERE route = ?', [SOURCE]);
    const [r] = await pool.query('INSERT INTO pages (route, name, sort_order) VALUES (?, ?, ?)',
      [TARGET.route, TARGET.name, sib?.sort_order != null ? Number(sib.sort_order) + 1 : 0]);
    page = { id: r.insertId };
    console.log(`Page ${TARGET.route}: registered as "${TARGET.name}" (id ${page.id}).`);
  }

  if (dryRun || !page) {
    console.log('\nDry run -- nothing written.');
    console.log('The real run carries the grants above across and grants System Admin in full.');
    await pool.end();
    return;
  }

  // can_edit on Production is what let someone inspect, so it becomes can_add here -- and can_edit
  // as well, since the same right also cancelled one. Copied only for users who do not already
  // have a row, so re-running never clobbers a grant somebody has since changed deliberately.
  const [upp] = await pool.query(
    `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print${extraCols.length ? `, ${extraCols.join(', ')}` : ''})
     SELECT src.user_id, ?, src.can_view, src.can_edit, src.can_edit, FALSE, FALSE, FALSE${extraSel.length ? `, ${extraSel.join(', ')}` : ''}
       FROM user_page_permissions src
      WHERE src.page_id = ?
        AND (src.can_view = TRUE OR src.can_edit = TRUE)
        AND NOT EXISTS (
          SELECT 1 FROM (SELECT user_id FROM user_page_permissions WHERE page_id = ?) existing
           WHERE existing.user_id = src.user_id)`,
    [page.id, source.id, page.id],
  );
  console.log(`  user_page_permissions: ${upp.affectedRows} grant(s) carried over from ${SOURCE}.`);

  const [atp] = await pool.query(
    `INSERT INTO account_type_permissions (account_type, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print${extraCols.length ? `, ${extraCols.join(', ')}` : ''}, updated_at)
     SELECT src.account_type, ?, src.can_view, src.can_edit, src.can_edit, FALSE, FALSE, FALSE${extraSel.length ? `, ${extraSel.join(', ')}` : ''}, NOW()
       FROM account_type_permissions src
      WHERE src.page_id = ?
        AND (src.can_view = TRUE OR src.can_edit = TRUE)
        AND NOT EXISTS (
          SELECT 1 FROM (SELECT account_type FROM account_type_permissions WHERE page_id = ?) existing
           WHERE existing.account_type = src.account_type)`,
    [page.id, source.id, page.id],
  );
  console.log(`  account_type_permissions: ${atp.affectedRows} template row(s) carried over.`);

  // requirePermission reads the actual row and does NOT bypass for System Admin, so the grant has
  // to exist rather than being implied by the account type.
  const cols = ['can_view', 'can_add', 'can_edit', 'can_delete', 'can_approve', 'can_print'].concat(extraCols);
  await pool.query(
    `INSERT INTO user_page_permissions (user_id, page_id, ${cols.join(', ')})
     SELECT u.id, ?, ${cols.map(() => 'TRUE').join(', ')} FROM users u
      WHERE u.account_type = 'System Admin'
        AND NOT EXISTS (SELECT 1 FROM (SELECT user_id FROM user_page_permissions WHERE page_id = ?) e
                         WHERE e.user_id = u.id)`,
    [page.id, page.id],
  );
  await pool.query(
    `UPDATE user_page_permissions upp JOIN users u ON u.id = upp.user_id
        SET ${cols.map((c) => `upp.${c} = TRUE`).join(', ')}
      WHERE u.account_type = 'System Admin' AND upp.page_id = ?`, [page.id],
  );
  console.log('  System Admin granted in full.');

  const [[see]] = await pool.query(
    'SELECT COUNT(*) AS n FROM user_page_permissions WHERE page_id = ? AND can_view = TRUE', [page.id]);
  const [[add]] = await pool.query(
    'SELECT COUNT(*) AS n FROM user_page_permissions WHERE page_id = ? AND can_add = TRUE', [page.id]);
  console.log(`\n  ${see.n} user(s) can see Quality Inspection, ${add.n} can perform one.`);
  console.log('\nIt now appears in Users & Permissions as "Quality Inspection". Grant Can Add to QC');
  console.log('rather than handing out Can Edit on Production.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
