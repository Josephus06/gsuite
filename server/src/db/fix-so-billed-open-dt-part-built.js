// Sales Orders reading BILLED whose only billing document is an open Delivery Ticket for part of the
// order, with production only partly built (2026-10-08, SO-62932: 657 ordered, 131 built, DT-6377 for
// 131). refresh-so-status-billing-docs.js moved every order with a DT/SI/DR to Billed before the
// Partially Billed status existed, and fix-so-partially-billed.js only corrects orders with an
// invoiced line -- these have none yet, so they stayed Billed.
//
// Each such order gets the status the app's own rule gives (computeSalesOrderStatus, as every
// status recompute does); only a change to Partially Billed is applied. Logged on the order.
//
//   node src/db/fix-so-billed-open-dt-part-built.js            # preview
//   node src/db/fix-so-billed-open-dt-part-built.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { computeSalesOrderStatus, invoicedOrTicketedSql } = require('../lib/salesOrderStatus');

const APPLY = process.argv.includes('--apply');

(async () => {
  // salesOrderStatus.js learns whether the status column takes partially_billed asynchronously.
  await new Promise((r) => setTimeout(r, 500));
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [[admin]] = await pool.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1");
  const [orders] = await pool.query(
    `SELECT so.id, so.sales_order_no, so.status FROM sales_orders so
      WHERE so.status = 'billed'
        AND NOT EXISTS (SELECT 1 FROM sales_invoices si WHERE si.sales_order_id = so.id AND si.status <> 'cancelled')
        AND EXISTS (SELECT 1 FROM delivery_tickets dt WHERE dt.sales_order_id = so.id AND dt.status = 'open')
        AND EXISTS (SELECT 1 FROM sales_order_lines sol JOIN job_orders jo ON jo.id = sol.job_order_id
                     WHERE sol.sales_order_id = so.id AND jo.quantity_built > 0 AND jo.quantity_built < sol.quantity)
      ORDER BY so.id`);
  let changed = 0;
  for (const so of orders) {
    const [lines] = await pool.query(
      `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, ${invoicedOrTicketedSql('jo')}
         FROM sales_order_lines sol LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`, [so.id]);
    const next = computeSalesOrderStatus(lines);
    if (next !== 'partially_billed') { console.log(`  ${so.sales_order_no}: rule gives ${next} -- left alone`); continue; }
    changed += 1;
    console.log(`  ${so.sales_order_no}: billed -> partially_billed`);
    if (!APPLY) continue;
    await pool.query("UPDATE sales_orders SET status = 'partially_billed', updated_at = NOW() WHERE id = ?", [so.id]);
    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('SalesOrder', ?, 'Updated', 'status', 'billed', 'partially_billed', ?)`, [so.id, admin.id]);
  }
  console.log(`${orders.length} order(s) checked, ${changed} ${APPLY ? 'changed' : 'would change'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
