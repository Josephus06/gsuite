// Backfill: rolls the Assembly Build / Quality Inspection / Item Delivery quantities up onto the
// Job Order header fields (quantity_built, quantity_inspected, quantity_delivered).
// import-production-stages.js created the AB/QI/delivery records with the right quantities but
// never wrote them back to job_orders, so migrated JOs show "Qty Built/Inspected/Delivered: 0"
// even when Completed/Delivered -- which hides the Sales Order's Bill button (the SO keeps offering
// Item Delivery instead). quantity_built = sum of non-cancelled ABs' quantity_built;
// quantity_inspected = sum of their passed_qty when the JO has a Quality Inspection;
// quantity_delivered = sum of the JO's non-cancelled Item Delivery line quantities.
//
// Idempotent and safe to re-run: it only fills JOs whose header qty is still 0/NULL, so JOs that
// already carry a correct built/inspected qty are left untouched.
//
//   node src/db/rollup-jo-production-qty.js --dry-run
//   node src/db/rollup-jo-production-qty.js
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const [[before]] = await pool.query(
    "SELECT COUNT(*) n FROM job_orders jo JOIN assembly_builds ab ON ab.job_order_id = jo.id WHERE (jo.quantity_built IS NULL OR jo.quantity_built = 0) AND ab.quantity_built > 0"
  );
  console.log(`JOs with an Assembly Build but quantity_built = 0: ${before.n}`);

  if (DRY_RUN) { console.log('DRY RUN -- nothing written.'); await pool.end(); return; }

  const [built] = await pool.query(
    `UPDATE job_orders jo
     JOIN (SELECT job_order_id, SUM(quantity_built) AS qb, SUM(passed_qty) AS pq
           FROM assembly_builds WHERE status <> 'cancelled' GROUP BY job_order_id) a ON a.job_order_id = jo.id
     SET jo.quantity_built = a.qb
     WHERE jo.quantity_built IS NULL OR jo.quantity_built = 0`
  );
  console.log(`Set quantity_built on ${built.affectedRows} JO(s).`);

  const [inspected] = await pool.query(
    `UPDATE job_orders jo
     JOIN (SELECT job_order_id, SUM(passed_qty) AS pq
           FROM assembly_builds WHERE status <> 'cancelled' GROUP BY job_order_id) a ON a.job_order_id = jo.id
     SET jo.quantity_inspected = a.pq
     WHERE (jo.quantity_inspected IS NULL OR jo.quantity_inspected = 0)
       AND EXISTS (SELECT 1 FROM quality_inspections qi WHERE qi.job_order_id = jo.id AND qi.status <> 'cancelled')`
  );
  console.log(`Set quantity_inspected on ${inspected.affectedRows} JO(s).`);

  // Fallback for Completed / Invoiced JOs that carry no Assembly Build at all: being fully done,
  // their built and inspected quantity is the full order quantity.
  const [fallback] = await pool.query(
    `UPDATE job_orders
     SET quantity_built = quantity, quantity_inspected = quantity
     WHERE production_stage IN ('completed', 'invoiced')
       AND (quantity_built IS NULL OR quantity_built = 0) AND quantity > 0`
  );
  console.log(`Fallback (completed JOs with no Assembly Build): ${fallback.affectedRows} JO(s) set to full quantity.`);

  // quantity_delivered from the JO's Item Delivery lines (non-cancelled deliveries). Until this is
  // set the Sales Order keeps offering "Item Delivery" instead of the "Bill" button.
  const [delivered] = await pool.query(
    `UPDATE job_orders jo
     JOIN (SELECT idl.job_order_id, SUM(idl.qty_delivered) AS qd
           FROM item_delivery_lines idl JOIN item_deliveries d ON d.id = idl.item_delivery_id
           WHERE d.status <> 'cancelled' GROUP BY idl.job_order_id) x ON x.job_order_id = jo.id
     SET jo.quantity_delivered = x.qd
     WHERE jo.quantity_delivered IS NULL OR jo.quantity_delivered = 0`
  );
  console.log(`Set quantity_delivered on ${delivered.affectedRows} JO(s).`);

  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
