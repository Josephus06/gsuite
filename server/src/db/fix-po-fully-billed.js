// Purchase Orders that are FULLY BILLED but still read Pending Billing / Partially Billed
// (asked 2026-10-06). Two ways it happens:
//   - lines: every received line's billed_qty has caught up, but bill_status never moved;
//   - bills: the PO's Vendor Bills (not void) add up to its total, but the lines' billed_qty was never
//     advanced -- bills migrated from the source, or raised before that bookkeeping (PO-1210: one bill,
//     VB-2425, for the full 38,200).
// The list now ranks bill_status above an imported "Pending Billing" label, so setting bill_status to
// fully_billed is what moves these. Nothing else on the PO is changed.
//
//   node src/db/fix-po-fully-billed.js            # list them
//   node src/db/fix-po-fully-billed.js --apply    # set bill_status = fully_billed on each
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const N = "LOWER(REPLACE(TRIM(po.status), ' ', '_'))";

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [rows] = await pool.query(
    `SELECT po.id, po.po_no, po.status, po.bill_status, po.receipt_status, COALESCE(po.total_amount, 0) AS total,
            (SELECT COALESCE(SUM(vb.gross_amount), 0) FROM vendor_bills vb
              WHERE vb.purchase_order_id = po.id AND vb.status NOT IN ('void', 'voided', 'cancelled')) AS billed,
            (SELECT GROUP_CONCAT(vb.bill_no ORDER BY vb.id) FROM vendor_bills vb
              WHERE vb.purchase_order_id = po.id AND vb.status NOT IN ('void', 'voided', 'cancelled')) AS bills,
            (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id AND l.received_qty > 0) AS rec_lines,
            (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id AND l.received_qty > 0 AND l.billed_qty >= l.received_qty) AS billed_lines
       FROM purchase_orders po
      WHERE ${N} <> 'cancelled' AND COALESCE(po.bill_status, '') <> 'fully_billed' AND ${N} <> 'fully_billed'
        AND (${N} IN ('pending_billing', 'partially_billed') OR po.receipt_status = 'fully_received' OR po.bill_status = 'partially_billed')
      ORDER BY po.id`
  );
  const hits = [];
  for (const r of rows) {
    const byLines = Number(r.rec_lines) > 0 && Number(r.billed_lines) === Number(r.rec_lines);
    const byBills = Number(r.total) > 0 && r.bills && Number(r.billed) >= Number(r.total) - 0.01;
    if (!byLines && !byBills) continue;
    hits.push(r);
    console.log(`  ${r.po_no}: reads "${r.status}" (bill_status ${r.bill_status || '-'}) -- total ${Number(r.total).toFixed(2)}, `
      + `billed ${Number(r.billed).toFixed(2)} by ${r.bills || 'no bill'}${byLines ? ', every received line billed' : ''}`);
    if (APPLY) await pool.query("UPDATE purchase_orders SET bill_status = 'fully_billed' WHERE id = ?", [r.id]);
  }
  console.log(`${hits.length} PO(s) fully billed but not shown so${APPLY ? ' -- now Fully Billed' : ' -- preview, nothing written'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
