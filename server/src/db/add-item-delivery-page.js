// Gives Item Delivery its own permission row instead of borrowing Sales Orders'.
//
// It was built riding on /sales-orders, so "may I create a delivery" was really "may I edit a
// sales order". That conflates two different jobs: the warehouse raises deliveries and has no
// business rewriting the order, while Sales edits orders and may never touch the loading bay.
// It also meant Item Delivery could not be found in the permission grid at all -- there was no
// row to search for.
//
// The actions now mean what they say:
//   can_view    see the Item Delivery list and open one
//   can_add     create a delivery (was can_edit on Sales Orders)
//   can_edit    record or correct the delivery method, cost and reference
//   can_delete  cancel a delivery, which puts the quantity back on the Job Order
//
// NOBODY LOSES ACCESS. Existing grants on /sales-orders are copied across: can_view becomes
// can_view here, and can_edit -- which is what let someone create and cancel deliveries --
// becomes can_add + can_edit + can_delete. A migration that quietly locked the warehouse out of
// shipping would be a worse bug than the one it fixes.
//
// IDEMPOTENT: safe to re-run. Existing rows are left alone rather than overwritten, so a re-run
// cannot undo permissions someone has since adjusted by hand.
//
//   node src/db/add-item-delivery-page.js
const pool = require('../db');

const ROUTE = '/item-deliveries';
const SOURCE = '/sales-orders';

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  const [[source]] = await pool.query('SELECT id FROM pages WHERE route = ?', [SOURCE]);
  if (!source) throw new Error(`${SOURCE} is not registered, so its grants cannot be copied.`);

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`Page ${ROUTE}: already registered (id ${page.id}).`);
  } else {
    const [r] = await pool.query('INSERT INTO pages (route, name) VALUES (?, ?)', [ROUTE, 'Item Delivery']);
    page = { id: r.insertId };
    console.log(`Page ${ROUTE}: registered (id ${page.id}).`);
  }

  const hasViewAll = await columnExists('user_page_permissions', 'can_view_all');
  const viewAllCol = hasViewAll ? ', can_view_all' : '';
  const viewAllVal = hasViewAll ? ', src.can_view_all' : '';

  // Copied only for users who do not already have a row here, so re-running never clobbers a
  // grant somebody has since changed deliberately.
  const [upp] = await pool.query(
    `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print${viewAllCol})
     SELECT src.user_id, ?, src.can_view, src.can_edit, src.can_edit, src.can_edit, FALSE, FALSE${viewAllVal}
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
    `INSERT INTO account_type_permissions (account_type, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print${viewAllCol}, updated_at)
     SELECT src.account_type, ?, src.can_view, src.can_edit, src.can_edit, src.can_edit, FALSE, FALSE${viewAllVal}, NOW()
       FROM account_type_permissions src
      WHERE src.page_id = ?
        AND (src.can_view = TRUE OR src.can_edit = TRUE)
        AND NOT EXISTS (
          SELECT 1 FROM (SELECT account_type FROM account_type_permissions WHERE page_id = ?) existing
           WHERE existing.account_type = src.account_type)`,
    [page.id, source.id, page.id],
  );
  console.log(`  account_type_permissions: ${atp.affectedRows} template row(s) carried over.`);

  // System Admin is full everywhere by definition; make sure it holds here even if it somehow
  // had no /sales-orders row to copy from.
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

  const [[can]] = await pool.query(
    'SELECT COUNT(*) AS n FROM user_page_permissions WHERE page_id = ? AND can_add = TRUE', [page.id]);
  const [[see]] = await pool.query(
    'SELECT COUNT(*) AS n FROM user_page_permissions WHERE page_id = ? AND can_view = TRUE', [page.id]);
  console.log(`\n${see.n} user(s) can see Item Delivery, ${can.n} can create one.`);
  console.log('It now appears in Users & Permissions as "Item Delivery" -- grant it to the warehouse');
  console.log('rather than handing out Can Update on Sales Orders.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
