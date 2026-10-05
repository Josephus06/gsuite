// Recompute the status of every Sales Order that has an OPEN Delivery Ticket, now that quantity on
// an open ticket counts as billed (lib/salesOrderStatus.js openDtQtySql). Orders computed before
// that change still read Pending Billing for goods already on a ticket (SO-71114, 2026-10-05); a
// ticket raised, edited or voided from now on recomputes its own order. Only Pending Billing -> Billed
// is applied here.
//
//   node src/db/refresh-so-status-open-dts.js            # preview
//   node src/db/refresh-so-status-open-dts.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { computeSalesOrderStatus, invoicedOrTicketedSql } = require('../lib/salesOrderStatus');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [orders] = await pool.query(
    `SELECT DISTINCT so.id, so.sales_order_no, so.status
       FROM sales_orders so JOIN delivery_tickets dt ON dt.sales_order_id = so.id
      WHERE dt.status = 'open' AND so.status <> 'cancelled'
      ORDER BY so.id`
  );
  let changed = 0;
  for (const so of orders) {
    const [lines] = await pool.query(
      `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, ${invoicedOrTicketedSql('jo')}
         FROM sales_order_lines sol LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`,
      [so.id]
    );
    const next = computeSalesOrderStatus(lines);
    // Forward only: an order leaves Pending Billing for Billed when its tickets now cover it. Any
    // other change is left alone -- migrated orders often carry Job Order quantities the source never
    // filled in, and recomputing those would drag a Billed order back to Pending Billing.
    if (!(next === 'billed' && ['pending_billing', 'pending_billing_partially_delivered'].includes(so.status))) continue;
    changed += 1;
    console.log(`  ${so.sales_order_no}: ${so.status} -> ${next}`);
    if (APPLY) await pool.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [next, so.id]);
  }
  console.log(`${orders.length} order(s) with an open ticket, ${changed} ${APPLY ? 'updated' : 'would change'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
