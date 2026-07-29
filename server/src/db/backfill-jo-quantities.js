// The sales import set each JO's number/qty but left the production quantities
// (quantity_built / quantity_inspected / quantity_delivered / quantity_invoiced) at 0, so
// the Sales Order / Job Order screens show "Qty Built: 0" and the status-driven action
// buttons (Item Delivery, Bill) never appear -- those key off delivered > invoiced etc.
//
// Live computes those from assembly-build/QI/delivery records; here we derive the reached
// stage from the (authoritative, already-migrated) sales order status and fill the JO
// quantities to match, so each order sits at the right point in the pipeline:
//   billed                              -> built = inspected = delivered = invoiced = qty
//   pending_billing[/partly delivered]  -> built = inspected = delivered = qty, invoiced = 0
//   partially_delivered                 -> built = inspected = delivered = qty, invoiced = 0
//   pending_delivery                    -> built = inspected = qty, delivered = 0
//   jo_in_process / pending_for_jo      -> 0 (still in production)
//
//   node src/db/backfill-jo-quantities.js --dry-run
//   node src/db/backfill-jo-quantities.js
const pool = require('../db');
require('dotenv').config();
const DRY_RUN = process.argv.includes('--dry-run');

const BUILT = "('billed','pending_billing','pending_billing_partially_delivered','pending_delivery','partially_delivered')";
const DELIVERED = "('billed','pending_billing','pending_billing_partially_delivered','partially_delivered')";
const INVOICED = "('billed')";

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING.\n');

  const [[prev]] = await pool.query(
    `SELECT COUNT(*) c FROM job_orders jo JOIN sales_orders so ON so.id = jo.sales_order_id
      WHERE jo.quantity_built = 0 AND jo.quantity IS NOT NULL`);
  console.log(`Job orders with quantity_built still 0: ${prev.c}`);

  if (!DRY_RUN) {
    const [r] = await pool.query(
      `UPDATE job_orders jo JOIN sales_orders so ON so.id = jo.sales_order_id
          SET jo.quantity_built     = CASE WHEN so.status IN ${BUILT}     THEN jo.quantity ELSE 0 END,
              jo.quantity_inspected = CASE WHEN so.status IN ${BUILT}     THEN jo.quantity ELSE 0 END,
              jo.quantity_delivered = CASE WHEN so.status IN ${DELIVERED} THEN jo.quantity ELSE 0 END,
              jo.quantity_invoiced  = CASE WHEN so.status IN ${INVOICED}  THEN jo.quantity ELSE 0 END
        WHERE jo.quantity IS NOT NULL`);
    console.log(`Updated ${r.affectedRows} job order(s).`);

    const [dist] = await pool.query(
      `SELECT so.status, COUNT(*) jos,
              SUM(jo.quantity_built>0) built, SUM(jo.quantity_delivered>0) delivered, SUM(jo.quantity_invoiced>0) invoiced
         FROM job_orders jo JOIN sales_orders so ON so.id = jo.sales_order_id
        GROUP BY so.status ORDER BY jos DESC`);
    console.table(dist);
  }
  if (DRY_RUN) console.log('\nDRY RUN -- nothing written.');
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
