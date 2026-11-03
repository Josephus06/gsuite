// "Refresh from source" (lib/liveStatusSync.js) used to set EVERY JO on an order to Completed once
// the source called the order Pending Delivery / Pending Billing -- which the source does as soon as
// one of its JOs is done. JO-60582-4-10, nothing built, inspected or delivered, read "Released
// Completed" with its nine siblings (2026-11-03). The sync now completes only a JO that has passed
// QI itself; this puts back the JOs it already completed.
//
// A Completed JO is put back when it has inspected less than its quantity AND its order has no
// billing document (an invoice / DR not cancelled, or a delivery ticket not voided). A billed order is
// old, finished work -- many migrated JOs carry no build or QI from the source -- and is left alone.
// Its stage then follows its own T1S work, the rule the build and QI routes use:
//   something inspected              -> Partially Completed
//   built but not inspected          -> For QI
//   nothing built                    -> In-Process
// Its Sales Order is then recomputed the way the app does it (lib/salesOrderStatus.js).
//
//   node src/db/fix-unearned-completed-jos.js                  # preview
//   node src/db/fix-unearned-completed-jos.js JO-60582-4-10    # preview one
//   node src/db/fix-unearned-completed-jos.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { computeSalesOrderStatus, invoicedOrTicketedSql, statusRuleReady } = require('../lib/salesOrderStatus');

const APPLY = process.argv.includes('--apply');
const ONE = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;
const n = (v) => Number(v || 0);

(async () => {
  await statusRuleReady;
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [jos] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.sales_order_id, jo.quantity, jo.quantity_built, jo.quantity_inspected,
            jo.quantity_delivered, so.sales_order_no, so.status AS so_status, YEAR(jo.created_at) AS yr
       FROM job_orders jo
       JOIN sales_orders so ON so.id = jo.sales_order_id
      WHERE jo.status = 'Released' AND jo.production_stage = 'completed'
        AND jo.quantity > 0 AND COALESCE(jo.quantity_inspected, 0) < jo.quantity
        AND so.status NOT IN ('billed', 'partially_billed', 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM delivery_tickets dt WHERE dt.sales_order_id = so.id AND dt.status <> 'void')
        AND NOT EXISTS (SELECT 1 FROM sales_invoices si WHERE si.sales_order_id = so.id AND si.status <> 'cancelled')
        ${ONE ? 'AND jo.job_order_no = ?' : ''}
      ORDER BY jo.id`,
    ONE ? [ONE] : []);

  const sos = new Set();
  const byYear = {};
  for (const jo of jos) {
    const stage = n(jo.quantity_inspected) > 0 ? 'partially_completed' : n(jo.quantity_built) > 0 ? 'for_qi' : 'in_process';
    byYear[jo.yr] = (byYear[jo.yr] || 0) + 1;
    console.log(`  ${jo.job_order_no} (${jo.sales_order_no} ${jo.so_status}): completed -> ${stage}  (qty ${n(jo.quantity)}, built ${n(jo.quantity_built)}, inspected ${n(jo.quantity_inspected)}, delivered ${n(jo.quantity_delivered)})`);
    if (APPLY) await pool.query('UPDATE job_orders SET production_stage = ?, updated_at = NOW() WHERE id = ? AND production_stage = \'completed\'', [stage, jo.id]);
    sos.add(jo.sales_order_id);
  }

  let soChanged = 0;
  for (const soId of sos) {
    const [[so]] = await pool.query('SELECT sales_order_no, status FROM sales_orders WHERE id = ?', [soId]);
    const [lines] = await pool.query(
      `SELECT sol.job_order_id, sol.quantity, j.quantity_built, j.quantity_inspected, j.quantity_delivered, ${invoicedOrTicketedSql('j')}
         FROM sales_order_lines sol LEFT JOIN job_orders j ON j.id = sol.job_order_id WHERE sol.sales_order_id = ?`, [soId]);
    const next = computeSalesOrderStatus(lines);
    if (next === so.status) continue;
    soChanged += 1;
    console.log(`  ${so.sales_order_no}: ${so.status} -> ${next}`);
    if (APPLY) await pool.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [next, soId]);
  }

  console.log('By JO year:', JSON.stringify(byYear));
  console.log(`${jos.length} JO(s) and ${soChanged} Sales Order(s) ${APPLY ? 'put back' : 'to put back'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
