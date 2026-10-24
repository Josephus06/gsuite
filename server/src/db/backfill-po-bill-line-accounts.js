// A PO bill's Non-Inventory line debits its item's expense account, as the source posts it
// (2026-10-24; computeVendorBillGl). Bills T1S posts itself (no imported source entry) from the
// books' start on had those lines debiting 20300 Inventory Received Not Billed; this gives each such
// line its item's expense account. Bills in periods closed for A/P are left as they posted.
//
//   node src/db/backfill-po-bill-line-accounts.js           # dry run
//   node src/db/backfill-po-bill-line-accounts.js --apply
require('dotenv').config();
const pool = require('../db');
const { periodLock } = require('../lib/accountingPeriod');
const { booksStart } = require('../lib/openingBalances');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- DRY RUN'}`);
  const books = await booksStart();
  const [rows] = await pool.query(
    `SELECT vbl.id, vb.bill_no, vb.date_created, vbl.net_of_tax, i.expense_account_id, a.account_code
       FROM vendor_bill_lines vbl
       JOIN vendor_bills vb ON vb.id = vbl.vendor_bill_id
       JOIN inventories i ON i.id = vbl.item_id
       JOIN chart_of_accounts a ON a.id = i.expense_account_id
      WHERE vb.purchase_order_id IS NOT NULL AND vb.status <> 'cancelled' AND vbl.account_id IS NULL
        AND i.item_type = 'Non-Inventory' AND vb.date_created >= ?
        AND NOT EXISTS (SELECT 1 FROM live_gl_entries g WHERE g.source_type = 'vendor_bill' AND g.source_id = vb.id)`,
    [books ? books.start : '2026-10-01']);
  const open = [];
  for (const r of rows) if (!(await periodLock(String(r.date_created).slice(0, 10), 'ap'))) open.push(r);
  console.log(`  ${rows.length} line(s); ${open.length} in open periods, total ${open.reduce((s, r) => s + Number(r.net_of_tax), 0).toFixed(2)}`);
  for (const r of open.slice(0, 15)) console.log(`    ${r.bill_no} ${String(r.date_created).slice(0, 10)} ${r.net_of_tax} -> ${r.account_code}`);
  if (APPLY) {
    for (const r of open) await pool.query('UPDATE vendor_bill_lines SET account_id = ? WHERE id = ? AND account_id IS NULL', [r.expense_account_id, r.id]);
    console.log(`  filled ${open.length}`);
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
