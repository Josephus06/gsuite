// PO4s of 10,000 or less sitting in Pending Approval (GM), moved back to Pending Approval (asked
// 2026-10-20). They went straight to the GM tier while PO3 / PO4 were created there whatever the amount
// (54dcc5e); PO4 now starts with the Purchasing Supervisor like PO1 / PO2 (ef44e14), and one of 10,000
// or less is approved outright at that tier -- so these were waiting on a General Manager they no
// longer need. Each change is written to the PO's audit trail. PO3s, and PO4s over 10,000, are left.
//
//   node src/db/fix-po4-pending-gm.js            # list them
//   node src/db/fix-po4-pending-gm.js --apply
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const THRESHOLD = 10000; // routes/purchaseOrders.js APPROVAL_THRESHOLD

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}\n`);
  // Both spellings of the GM tier: the app's 'pending_approval_gm' and an imported 'Pending Approval for GM'.
  const [rows] = await pool.query(
    `SELECT id, po_no, status, total_amount, date_created FROM purchase_orders
      WHERE type = 'PO4' AND total_amount <= ?
        AND LOWER(REPLACE(status, ' ', '_')) IN ('pending_approval_gm', 'pending_approval_for_gm')
      ORDER BY id`, [THRESHOLD]);
  for (const r of rows) {
    console.log(`  ${r.po_no}  ${String(r.date_created).slice(0, 10)}  ${Number(r.total_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}  ${r.status} -> pending_approval`);
    if (!APPLY) continue;
    await pool.query("UPDATE purchase_orders SET status = 'pending_approval' WHERE id = ?", [r.id]);
    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('PurchaseOrder', ?, 'Updated', 'status', ?, 'pending_approval', NULL)`, [r.id, r.status]);
  }
  console.log(`\n${rows.length} PO4(s) of ${THRESHOLD.toLocaleString('en-US')} or less ${APPLY ? 'moved back to' : 'would move back to'} Pending Approval.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
