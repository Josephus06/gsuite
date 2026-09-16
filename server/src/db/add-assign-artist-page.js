// Gives "assign an artist to a Job Order" a permission row of its own.
//
// Until now the act was gated on the `is_design_supervisor` flag, with generic can_edit on
// /job-orders as an admin fallback. Neither is the right shape:
//
//   * flagging someone is_design_supervisor so they can assign ALSO scopes their whole Job Orders
//     list down to the design queue (lib/designSupervisorVisibility.js). A planner or a manager
//     who just needs to hand a stuck order to an artist loses sight of every other job order --
//     so in practice the only way to grant the right was to break the grantee's screen;
//   * can_edit on /job-orders is the right to rewrite the description, the dates and the
//     materials. Handing that out so somebody can pick an artist grants far more than intended,
//     and the generic edit form deliberately refused the artist field anyway -- so the two gates
//     disagreed about the same act depending on which button you pressed.
//
// After this, one row in the permission grid means exactly "may pick who draws this job":
//
//   /job-orders/assign-artist   can_edit ("Can Update")  assign or reassign the artist + Layout
//                                                        Job Type, on a standard Job Order
//                                                        (PUT /job-orders/:id/assign-design and
//                                                        the artist field on the JO edit form)
//                                                        and on a Non-Standard Job Order
//                                                        (PUT /non-standard-job-orders/:id/
//                                                        assign-artist).
//
// Every other action is left FALSE and means nothing here: the row has no screen of its own, so
// can_view grants no list to see, and nothing deletes, approves or prints an assignment. Granting
// them would be theatre.
//
// WHAT STAYS ON THE FLAG: is_design_supervisor still decides whose design queue an order appears
// in, who gets the "needs an artist assigned" notification, and who may send an order back to
// Sales instead of assigning it. Those are "this is my queue" judgements rather than a right to be
// handed out, and none of them changes here.
//
// NOBODY LOSES ACCESS. The grant is seeded for everyone who can assign today -- every design
// supervisor, everyone holding can_edit on /job-orders (the old admin fallback), and every System
// Admin. A migration that quietly stopped the design team from assigning work would be a worse bug
// than the one it fixes.
//
// AFTER THIS RUNS, THE FLAG NO LONGER IMPLIES THE RIGHT. Flagging a NEW user is_design_supervisor
// gives them the design queue but not the assign button -- tick "JO Assign Artist > Can Update" on
// their permissions as well. That is the point of the change: a permission you cannot revoke in
// the grid is not a permission.
//
// SAFE TO SHIP BEFORE THIS RUNS: mayAssignArtist() falls back to the old rule for as long as the
// page row is absent, so the code can deploy first and this can follow. (Unlike requirePermission,
// which answers a missing page row with a 500 -- that is what makes its deploy order unforgiving.)
//
// IDEMPOTENT: existing rows are left alone rather than overwritten, so a re-run cannot undo a
// grant someone has since adjusted by hand. The second run reports 0 new grants.
//
//   node src/db/add-assign-artist-page.js
const pool = require('../db');

const ROUTE = '/job-orders/assign-artist';
const NAME = 'JO Assign Artist';
const SOURCE = '/job-orders';

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [[source]] = await pool.query('SELECT id FROM pages WHERE route = ?', [SOURCE]);
  if (!source) throw new Error(`${SOURCE} is not registered, so its grants cannot be carried over.`);

  const hasViewAll = await columnExists('user_page_permissions', 'can_view_all');
  const viewAllCol = hasViewAll ? ', can_view_all' : '';
  const viewAllFalse = hasViewAll ? ', FALSE' : '';

  // Sorted next to Job Orders in the grid rather than dumped at the top, since that is where
  // anyone looking for it will look.
  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`\nPage ${ROUTE}: already registered (id ${page.id}).`);
  } else {
    const [[jo]] = await pool.query('SELECT sort_order FROM pages WHERE route = ?', [SOURCE]);
    const [r] = await pool.query(
      'INSERT INTO pages (route, name, sort_order) VALUES (?, ?, ?)', [ROUTE, NAME, jo?.sort_order || 0],
    );
    page = { id: r.insertId };
    console.log(`\nPage ${ROUTE}: registered as "${NAME}" (id ${page.id}).`);
  }

  // 1. Everyone who can assign today because they are flagged a design supervisor.
  const [flagged] = await pool.query(
    `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print${viewAllCol})
     SELECT u.id, ?, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE${viewAllFalse}
       FROM users u
      WHERE u.is_design_supervisor = TRUE
        AND NOT EXISTS (SELECT 1 FROM (SELECT user_id FROM user_page_permissions WHERE page_id = ?) e
                         WHERE e.user_id = u.id)`,
    [page.id, page.id],
  );
  console.log(`  ${flagged.affectedRows} design supervisor(s) carried over.`);

  // 2. Everyone who can assign today through the old can_edit-on-Job-Orders fallback.
  const [fallback] = await pool.query(
    `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print${viewAllCol})
     SELECT src.user_id, ?, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE${viewAllFalse}
       FROM user_page_permissions src
      WHERE src.page_id = ? AND src.can_edit = TRUE
        AND NOT EXISTS (SELECT 1 FROM (SELECT user_id FROM user_page_permissions WHERE page_id = ?) e
                         WHERE e.user_id = src.user_id)`,
    [page.id, source.id, page.id],
  );
  console.log(`  ${fallback.affectedRows} holder(s) of can_edit on ${SOURCE} carried over.`);

  // 3. The account-type template, so a new user created from a template that could assign still
  //    can. Same fallback source, mapped onto can_edit.
  const [tpl] = await pool.query(
    `INSERT INTO account_type_permissions (account_type, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print${viewAllCol}, updated_at)
     SELECT src.account_type, ?, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE${viewAllFalse}, NOW()
       FROM account_type_permissions src
      WHERE src.page_id = ? AND src.can_edit = TRUE
        AND NOT EXISTS (SELECT 1 FROM (SELECT account_type FROM account_type_permissions WHERE page_id = ?) e
                         WHERE e.account_type = src.account_type)`,
    [page.id, source.id, page.id],
  );
  console.log(`  ${tpl.affectedRows} account-type template row(s) carried over.`);

  // 4. System Admin explicitly. requirePermission reads the actual row rather than bypassing for
  //    System Admin, so every registration script has to grant it -- mayAssignArtist's own
  //    short-circuit should not be the only thing holding it up.
  const cols = ['can_view', 'can_add', 'can_edit', 'can_delete', 'can_approve', 'can_print']
    .concat(hasViewAll ? ['can_view_all'] : []);
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

  const [who] = await pool.query(
    `SELECT u.username, u.account_type, u.is_design_supervisor
       FROM user_page_permissions upp JOIN users u ON u.id = upp.user_id
      WHERE upp.page_id = ? AND upp.can_edit = TRUE ORDER BY u.username`, [page.id],
  );
  console.log(`\n${who.length} account(s) may now assign an artist:`);
  who.forEach((u) => console.log(`  ${String(u.username).padEnd(24)} ${u.account_type}${u.is_design_supervisor ? ' (design supervisor)' : ''}`));
  console.log(`\nIt shows in Users & Permissions as "${NAME}" -- the Can Update column is the one that matters.`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
