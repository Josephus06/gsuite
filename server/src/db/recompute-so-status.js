// Recompute named Sales Orders' status from their own lines (lib/salesOrderStatus.js), after a repair
// raised their JOs' invoiced quantity -- relink-invoice-lines-from-source.js updates the JO but not its
// order, so SO-72140 still read Partially Billed with both JOs invoiced (2026-11-10).
// Also moves each JO at Completed that is now fully invoiced to Invoiced. Forward only: an order or
// JO is never moved back.
//
//   node src/db/recompute-so-status.js SO-72140            # preview
//   node src/db/recompute-so-status.js SO-72140,SO-1 --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { computeSalesOrderStatus, invoicedOrTicketedSql, statusRuleReady } = require('../lib/salesOrderStatus');

const APPLY = process.argv.includes('--apply');
const NOS = (process.argv.slice(2).find((a) => !a.startsWith('--')) || '').split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
const RANK = ['pending_for_jo', 'jo_in_process', 'pending_delivery', 'partially_delivered',
  'pending_billing_partially_delivered', 'pending_billing', 'partially_billed', 'billed'];
const n = (v) => Number(v || 0);

(async () => {
  if (!NOS.length) { console.error('Name the order(s): SO-72140,SO-1'); process.exit(2); }
  await statusRuleReady;
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  for (const no of NOS) {
    const [[so]] = await pool.query('SELECT id, sales_order_no, status FROM sales_orders WHERE sales_order_no = ?', [no]);
    if (!so) { console.log(`${no}: not found`); continue; }
    const [jos] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.quantity, jo.quantity_invoiced, jo.production_stage
         FROM sales_order_lines sol JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`, [so.id]);
    for (const j of jos) {
      const full = n(j.quantity) > 0 && n(j.quantity_invoiced) >= n(j.quantity) - 0.0001;
      console.log(`  ${j.job_order_no}: invoiced ${n(j.quantity_invoiced)}/${n(j.quantity)}, ${j.production_stage}`);
      if (full && j.production_stage === 'completed') {
        console.log(`    -> invoiced`);
        if (APPLY) await pool.query("UPDATE job_orders SET production_stage = 'invoiced', updated_at = NOW() WHERE id = ?", [j.id]);
      }
    }
    if (so.status === 'cancelled') { console.log(`${no}: cancelled -- left alone`); continue; }
    const [lines] = await pool.query(
      `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, ${invoicedOrTicketedSql('jo')}
         FROM sales_order_lines sol LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`, [so.id]);
    const next = computeSalesOrderStatus(lines);
    const back = RANK.includes(so.status) && RANK.includes(next) && RANK.indexOf(next) < RANK.indexOf(so.status);
    if (next === so.status) { console.log(`${no}: ${so.status} -- already right`); continue; }
    if (back) { console.log(`${no}: ${so.status}, rule says ${next} -- not moved back`); continue; }
    console.log(`${no}: ${so.status} -> ${next}`);
    if (APPLY) await pool.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [next, so.id]);
  }
  if (!APPLY) console.log('PREVIEW -- add --apply to write.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
