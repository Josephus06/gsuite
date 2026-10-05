// Move every Sales Order that already has a billing document -- a Delivery Ticket that is not
// voided, or a Sales Invoice / Delivery Receipt that is not cancelled -- to Billed. That is now the
// rule (lib/salesOrderStatus.js hasBillingDocSql); orders computed before it still read Pending
// Billing or similar with a DT/SI/DR on them (SO-71114, 2026-10-05). A document raised, edited or
// voided from now on recomputes its own order. Cancelled orders are left alone.
//
//   node src/db/refresh-so-status-billing-docs.js            # preview
//   node src/db/refresh-so-status-billing-docs.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [orders] = await pool.query(
    `SELECT so.id, so.sales_order_no, so.status
       FROM sales_orders so
      WHERE so.status NOT IN ('billed', 'cancelled')
        AND (EXISTS (SELECT 1 FROM delivery_tickets dt WHERE dt.sales_order_id = so.id AND dt.status <> 'void')
          OR EXISTS (SELECT 1 FROM sales_invoices si WHERE si.sales_order_id = so.id AND si.status <> 'cancelled'))
      ORDER BY so.id`
  );
  const byStatus = {};
  for (const so of orders) {
    byStatus[so.status] = (byStatus[so.status] || 0) + 1;
    console.log(`  ${so.sales_order_no}: ${so.status} -> billed`);
  }
  if (APPLY && orders.length) {
    await pool.query("UPDATE sales_orders SET status = 'billed', updated_at = NOW() WHERE id IN (?)", [orders.map((o) => o.id)]);
  }
  console.log('From:', byStatus);
  console.log(`${orders.length} order(s) ${APPLY ? 'updated' : 'would change'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
