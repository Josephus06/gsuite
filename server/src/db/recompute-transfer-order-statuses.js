// One-off migration: recomputes transfer_orders.status for every open order.
//
// computeTOStatus used to separate the two partial states by whether anything had been
// received yet (totalReceived > 0), which is wrong: what actually decides it is whether
// any fulfilled stock is still in transit. The very first partial fulfillment on an
// order therefore landed in 'partially_fulfilled' with nothing received, so the view
// screen's CAN_RECEIVE check never matched and the Receive button stayed hidden even
// though an Item Fulfillment was sitting there waiting to be received.
//
// Status is persisted, not derived on read, so orders already in that state keep the
// stale value until the next fulfil/receive. This restates them from their lines.
// Cancelled orders are left alone -- 'cancelled' is the one status set by hand and it is
// terminal. Idempotent -- safe to re-run:
//   node src/db/recompute-transfer-order-statuses.js --dry-run   (report only, no writes)
//   node src/db/recompute-transfer-order-statuses.js             (apply)
const pool = require('../db');
require('dotenv').config();

function computeTOStatus(lines) {
  const totalTarget = lines.reduce((s, l) => s + Number(l.adjusted_qty ?? l.qty), 0);
  const totalFulfilled = lines.reduce((s, l) => s + Number(l.fulfilled || 0), 0);
  const totalReceived = lines.reduce((s, l) => s + Number(l.received || 0), 0);
  if (totalFulfilled <= 0) return 'pending_fulfillment';
  if (totalFulfilled < totalTarget) return totalReceived < totalFulfilled ? 'pending_receipt_partially_fulfilled' : 'partially_fulfilled';
  return totalReceived < totalFulfilled ? 'pending_receipt' : 'received';
}

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  const [orders] = await pool.query(
    "SELECT id, to_no, status FROM transfer_orders WHERE status <> 'cancelled'",
  );

  let changed = 0;
  for (const o of orders) {
    const [lines] = await pool.query(
      'SELECT qty, adjusted_qty, fulfilled, received FROM transfer_order_lines WHERE transfer_order_id = ?',
      [o.id],
    );
    // An order with no lines has nothing to derive a status from; leave it as it stands.
    if (!lines.length) continue;

    const next = computeTOStatus(lines);
    if (next === o.status) continue;

    if (!DRY_RUN) {
      await pool.query('UPDATE transfer_orders SET status = ?, updated_at = NOW() WHERE id = ?', [next, o.id]);
    }
    console.log(`${o.to_no}: ${o.status} -> ${next}`);
    changed += 1;
  }

  if (!changed) {
    console.log(`No changes needed across ${orders.length} transfer order(s).`);
  } else if (DRY_RUN) {
    console.log(`\nWould restate ${changed} of ${orders.length} transfer order(s). Re-run without --dry-run to apply.`);
  } else {
    console.log(`\nRestated ${changed} of ${orders.length} transfer order(s).`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
