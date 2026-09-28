// Adds a can_void permission alongside can_view / can_add / can_edit / ... / can_print, so voiding
// a POSTED document can be granted on its own instead of coming free with the right to edit it.
//
// Until now 17 of the 20 posting documents below voided on can_edit -- anyone who could edit a
// Cheque could also wipe it out of the books. Asset Depreciation and Asset Disposal voided on
// can_approve, Item Delivery on can_delete.
//
// Cancelling a document that posts nothing (Purchase Requisition, Purchase Order, Transfer Order,
// NSSO, NSTDJO, Quality Inspection, Asset Transfer/Audit, OSR) is deliberately left on its old
// right -- the request was for posted transactions.
//
// NOBODY LOSES ACCESS ON THE DAY: each existing row gets can_void copied from whichever right
// used to allow the void on that page, and System Admin gets it everywhere (requirePermission
// reads the row, it does not bypass for admins). Take it away afterwards from Users & Permissions.
//
// Seeding only happens in the run that ADDS the column, so a re-run can never re-grant a void
// right that someone has since removed by hand. Droplet and office replicate both ways: run this
// on ONE of them. Railway needs its own run.
//
// Must run on an install BEFORE the code that reads can_void serves traffic there, or login's
// permission query and every void 500 on the missing column.
//
//   node src/db/add-can-void-permission.js
const pool = require('../db');

// route -> the right that allowed voiding it before can_void existed.
const VOIDED_BY = {
  '/sales-invoices': 'can_edit',
  '/delivery-tickets': 'can_edit',
  '/customer-payments': 'can_edit',
  '/credit-memos': 'can_edit',
  '/customer-refunds': 'can_edit',
  '/cheques': 'can_edit',
  '/deposits': 'can_edit',
  '/fund-transfers': 'can_edit',
  '/journals': 'can_edit',
  '/vendor-bills': 'can_edit',
  '/bill-payments': 'can_edit',
  '/bill-credits': 'can_edit',
  '/commission-vouchers': 'can_edit',
  '/commission-payables': 'can_edit',
  '/inventory-adjustments': 'can_edit',
  '/assembly-builds': 'can_edit',
  '/warranty-certificates': 'can_edit',
  '/item-deliveries': 'can_delete',
  '/asset-depreciation': 'can_approve',
  '/asset-disposals': 'can_approve',
};

async function hasColumn(table, column) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return row.n > 0;
}

// Appended, never AFTER <col>: positioning forces a full table rebuild under an exclusive lock.
async function addColumn(table) {
  if (await hasColumn(table, 'can_void')) {
    console.log(`  ${table}.can_void already exists -- skipped, and NOT re-seeded.`);
    return false;
  }
  await pool.query(`ALTER TABLE ${table} ADD COLUMN can_void BOOLEAN NOT NULL DEFAULT FALSE, ALGORITHM=INSTANT`);
  console.log(`  ${table}.can_void added.`);
  return true;
}

async function seed(table, adminWhere, adminJoin) {
  let carried = 0;
  for (const [route, from] of Object.entries(VOIDED_BY)) {
    const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
    if (!page) { console.warn(`  !! ${route} is not registered in pages -- nothing to carry over.`); continue; }
    const [r] = await pool.query(`UPDATE ${table} SET can_void = TRUE WHERE page_id = ? AND ${from} = TRUE`, [page.id]);
    carried += r.affectedRows;
  }
  const [a] = await pool.query(`UPDATE ${table} t ${adminJoin} SET t.can_void = TRUE WHERE ${adminWhere}`);
  console.log(`  ${table}: ${carried} row(s) carried over, ${a.affectedRows} System Admin row(s) granted.`);
}

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  if (await addColumn('user_page_permissions')) {
    await seed('user_page_permissions', "u.account_type = 'System Admin'", 'JOIN users u ON u.id = t.user_id');
  }
  if (await addColumn('account_type_permissions')) {
    await seed('account_type_permissions', "t.account_type = 'System Admin'", '');
  }

  const [rows] = await pool.query(
    `SELECT p.route, COUNT(*) AS n
       FROM user_page_permissions upp JOIN pages p ON p.id = upp.page_id
      WHERE upp.can_void = TRUE AND p.route IN (?)
      GROUP BY p.route ORDER BY p.route`,
    [Object.keys(VOIDED_BY)]
  );
  console.log('\nUsers who can void, by page:');
  for (const r of rows) console.log(`  ${r.route.padEnd(24)} ${r.n}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
