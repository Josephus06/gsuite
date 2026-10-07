// Sales Orders that read BILLED though only part of them is invoiced, and the Job Orders on them that
// read INVOICED though not invoiced (SO-70419, 2026-10-07). Cause: Sync from Source read the source's
// "Partially Billed" as Billed and set every JO on the order to Invoiced -- lib/liveStatusSync.js no
// longer does.
//
// An order is corrected only when its own figures can be trusted -- at least one line has been
// invoiced, and some line is invoiced short of its quantity -- so a migrated order whose Job Order
// quantities were never filled in is not dragged backward. Its status becomes what the app's rule
// gives (computeSalesOrderStatus, open-DT quantity counted as billed, as the app does). Each of its JOs
// marked Invoiced but invoiced short goes back to the stage its own figures show.
//
//   node src/db/fix-so-partially-billed.js                # preview, every order
//   node src/db/fix-so-partially-billed.js SO-70419       # preview one
//   node src/db/fix-so-partially-billed.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { computeSalesOrderStatus, invoicedOrTicketedSql } = require('../lib/salesOrderStatus');

const APPLY = process.argv.includes('--apply');
const ONE = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;
const n = (v) => Number(v || 0);

// A JO's stage from its own quantities, for one wrongly at Invoiced.
function stageFor(jo) {
  if (n(jo.quantity_invoiced) >= n(jo.quantity) && n(jo.quantity) > 0) return 'invoiced';
  if (n(jo.quantity_inspected) >= n(jo.quantity) && n(jo.quantity) > 0) return 'completed';
  if (n(jo.quantity_inspected) > 0) return 'partially_completed';
  return 'in_process';
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [orders] = await pool.query(
    `SELECT so.id, so.sales_order_no, so.status FROM sales_orders so
      WHERE so.status = 'billed' ${ONE ? 'AND so.sales_order_no = ?' : ''}
        AND EXISTS (SELECT 1 FROM sales_order_lines sol JOIN job_orders jo ON jo.id = sol.job_order_id
                     WHERE sol.sales_order_id = so.id AND jo.quantity_invoiced > 0)
        AND EXISTS (SELECT 1 FROM sales_order_lines sol JOIN job_orders jo ON jo.id = sol.job_order_id
                     WHERE sol.sales_order_id = so.id AND jo.quantity_invoiced < sol.quantity)
      ORDER BY so.id`, ONE ? [ONE] : []);
  let soFixed = 0; let joFixed = 0;
  for (const so of orders) {
    const [lines] = await pool.query(
      `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, ${invoicedOrTicketedSql('jo')}
         FROM sales_order_lines sol LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`, [so.id]);
    const next = computeSalesOrderStatus(lines);
    const [jos] = await pool.query(
      `SELECT id, job_order_no, quantity, quantity_inspected, quantity_invoiced, production_stage FROM job_orders
        WHERE sales_order_id = ? AND production_stage = 'invoiced' AND quantity_invoiced < quantity AND status <> 'Cancelled'`, [so.id]);
    if (next === 'billed' && !jos.length) continue;
    if (next !== 'billed') soFixed += 1;
    console.log(`  ${so.sales_order_no}: ${so.status} -> ${next}${jos.length ? `; JOs ${jos.map((j) => `${j.job_order_no} invoiced -> ${stageFor(j)}`).join(', ')}` : ''}`);
    if (!APPLY) { joFixed += jos.length; continue; }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (next !== 'billed') await conn.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [next, so.id]);
      for (const j of jos) {
        await conn.query('UPDATE job_orders SET production_stage = ?, updated_at = NOW() WHERE id = ?', [stageFor(j), j.id]);
        joFixed += 1;
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  console.log(`${orders.length} order(s) read Billed while part-invoiced; ${soFixed} order status(es) and ${joFixed} JO stage(s) ${APPLY ? 'corrected' : 'to correct'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
