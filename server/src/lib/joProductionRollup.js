// Rolls the Assembly Build / Quality Inspection / Item Delivery quantities up onto the Job Order
// header (quantity_built / quantity_inspected / quantity_delivered) so completed JOs don't show 0s
// (which also hides the Sales Order's Bill button). Pure local SQL, fast and idempotent -- only
// fills header fields that are still 0/NULL. Shared by rollup-jo-production-qty.js (CLI) and the
// "Sync from Source" button so both stay in step. See also reference: import-production-stages.js
// runs the same rollup at the end of a fresh preset import.
const pool = require('../db');

async function rollupJoQuantities() {
  const [built] = await pool.query(
    `UPDATE job_orders jo
     JOIN (SELECT job_order_id, SUM(quantity_built) AS qb FROM assembly_builds WHERE status <> 'cancelled' GROUP BY job_order_id) a ON a.job_order_id = jo.id
     SET jo.quantity_built = a.qb WHERE jo.quantity_built IS NULL OR jo.quantity_built = 0`
  );
  const [inspected] = await pool.query(
    `UPDATE job_orders jo
     JOIN (SELECT job_order_id, SUM(passed_qty) AS pq FROM assembly_builds WHERE status <> 'cancelled' GROUP BY job_order_id) a ON a.job_order_id = jo.id
     SET jo.quantity_inspected = a.pq
     WHERE (jo.quantity_inspected IS NULL OR jo.quantity_inspected = 0)
       AND EXISTS (SELECT 1 FROM quality_inspections qi WHERE qi.job_order_id = jo.id AND qi.status <> 'cancelled')`
  );
  // NO FALLBACK to the full quantity (removed 2026-10-09). It used to set built = inspected =
  // quantity on any completed/invoiced JO without a build, which put figures on the Sales Order the
  // source never had -- SO-60582 showed every line Built and QI'd where the source shows one -- and
  // raised an Item Delivery button the source does not offer. No build at the source means none here.
  const [delivered] = await pool.query(
    `UPDATE job_orders jo
     JOIN (SELECT idl.job_order_id, SUM(idl.qty_delivered) AS qd
           FROM item_delivery_lines idl JOIN item_deliveries d ON d.id = idl.item_delivery_id
           WHERE d.status <> 'cancelled' GROUP BY idl.job_order_id) x ON x.job_order_id = jo.id
     SET jo.quantity_delivered = x.qd WHERE jo.quantity_delivered IS NULL OR jo.quantity_delivered = 0`
  );
  return {
    built: built.affectedRows,
    inspected: inspected.affectedRows,
    delivered: delivered.affectedRows,
  };
}

module.exports = { rollupJoQuantities };
