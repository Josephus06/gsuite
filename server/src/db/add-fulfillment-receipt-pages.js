// Gives Item Fulfillment and Item Receipt permission rows of their own instead of borrowing the
// Transfer Order's.
//
// Both were built hanging off the Transfer Order, so the rights meant the wrong things:
//
//   "may I fulfill a transfer"  was really  can_approve on Transfer Orders
//   "may I receive a transfer"  was really  can_approve on Transfer Orders
//   "may I see the fulfillment/receipt lists"  was really  can_view on Transfer Orders
//
// That conflates three different jobs. The sending warehouse fulfills, the receiving warehouse
// receives, and neither necessarily approves transfer orders -- yet can_approve on Transfer Orders
// was the single switch for all of it, so granting someone the right to receive stock also let
// them fulfill it from the other end. It also meant neither document could be found in the
// permission grid at all: there was no row to search for.
//
// The actions now mean what they say:
//
//   /item-fulfillments  can_view    see the Item Fulfillment list and open one
//                       can_add     fulfill a transfer order (was can_approve on Transfer Orders)
//                       can_edit    reserved -- editing a saved fulfillment is not built yet, and
//                                   today only reveals the disabled Edit button on the view
//
//   /item-receipts      can_view    see the Item Receipt list and open one
//                       can_add     receive against a fulfillment (was can_approve on TOs)
//                       can_edit    reserved, as above
//
// can_delete and can_approve are left FALSE on both: there is no endpoint that deletes or approves
// either document, so granting them would be theatre. can_print likewise -- the Print buttons on
// these pages are disabled placeholders in this build.
//
// WHAT STAYS ON THE TRANSFER ORDER: the fulfillment list shown INSIDE a transfer order
// (GET /transfer-orders/:id/item-fulfillments, which also feeds the Receive picker) keeps using
// the Transfer Order's own can_view. The rule applied throughout is that an endpoint is gated by
// the PAGE IT SERVES, not by the entity it returns -- otherwise revoking Item Fulfillment access
// would blank out a panel in the middle of the Transfer Order screen.
//
// NOBODY LOSES ACCESS. Existing Transfer Order grants are copied across: can_view becomes can_view,
// and can_approve -- which is what let someone fulfill and receive -- becomes can_add. A migration
// that quietly stopped the warehouse from receiving stock would be a worse bug than the one it
// fixes.
//
// IDEMPOTENT: safe to re-run. Existing rows are left alone rather than overwritten, so a re-run
// cannot undo permissions someone has since adjusted by hand.
//
//   node src/db/add-fulfillment-receipt-pages.js
const pool = require('../db');

const SOURCE = '/transfer-orders';
const TARGETS = [
  { route: '/item-fulfillments', name: 'Item Fulfillment' },
  { route: '/item-receipts', name: 'Item Receipt' },
];

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function addPage({ route, name }, sourceId, hasViewAll) {
  const viewAllCol = hasViewAll ? ', can_view_all' : '';
  const viewAllVal = hasViewAll ? ', src.can_view_all' : '';

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
  if (page) {
    console.log(`\nPage ${route}: already registered (id ${page.id}).`);
  } else {
    const [r] = await pool.query('INSERT INTO pages (route, name) VALUES (?, ?)', [route, name]);
    page = { id: r.insertId };
    console.log(`\nPage ${route}: registered as "${name}" (id ${page.id}).`);
  }

  // can_approve on the Transfer Order is what let someone fulfill or receive, so it becomes
  // can_add here. Copied only for users who do not already have a row, so re-running never
  // clobbers a grant somebody has since changed deliberately.
  const [upp] = await pool.query(
    `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print${viewAllCol})
     SELECT src.user_id, ?, src.can_view, src.can_approve, src.can_edit, FALSE, FALSE, FALSE${viewAllVal}
       FROM user_page_permissions src
      WHERE src.page_id = ?
        AND (src.can_view = TRUE OR src.can_approve = TRUE OR src.can_edit = TRUE)
        AND NOT EXISTS (
          SELECT 1 FROM (SELECT user_id FROM user_page_permissions WHERE page_id = ?) existing
           WHERE existing.user_id = src.user_id)`,
    [page.id, sourceId, page.id],
  );
  console.log(`  user_page_permissions: ${upp.affectedRows} grant(s) carried over from ${SOURCE}.`);

  const [atp] = await pool.query(
    `INSERT INTO account_type_permissions (account_type, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print${viewAllCol}, updated_at)
     SELECT src.account_type, ?, src.can_view, src.can_approve, src.can_edit, FALSE, FALSE, FALSE${viewAllVal}, NOW()
       FROM account_type_permissions src
      WHERE src.page_id = ?
        AND (src.can_view = TRUE OR src.can_approve = TRUE OR src.can_edit = TRUE)
        AND NOT EXISTS (
          SELECT 1 FROM (SELECT account_type FROM account_type_permissions WHERE page_id = ?) existing
           WHERE existing.account_type = src.account_type)`,
    [page.id, sourceId, page.id],
  );
  console.log(`  account_type_permissions: ${atp.affectedRows} template row(s) carried over.`);

  // System Admin is full everywhere by definition; make sure it holds here even if it somehow
  // had no Transfer Order row to copy from.
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

  const [[see]] = await pool.query(
    'SELECT COUNT(*) AS n FROM user_page_permissions WHERE page_id = ? AND can_view = TRUE', [page.id]);
  const [[add]] = await pool.query(
    'SELECT COUNT(*) AS n FROM user_page_permissions WHERE page_id = ? AND can_add = TRUE', [page.id]);
  console.log(`  ${see.n} user(s) can see ${name}, ${add.n} can create one.`);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [[source]] = await pool.query('SELECT id FROM pages WHERE route = ?', [SOURCE]);
  if (!source) throw new Error(`${SOURCE} is not registered, so its grants cannot be copied.`);

  const hasViewAll = await columnExists('user_page_permissions', 'can_view_all');

  for (const target of TARGETS) await addPage(target, source.id, hasViewAll);

  console.log('\nBoth now appear in Users & Permissions as "Item Fulfillment" and "Item Receipt".');
  console.log('Grant them to the warehouse rather than handing out Can Approve on Transfer Orders.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
