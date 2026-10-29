// "Refresh from source" (lib/liveStatusSync.js) used to copy a Sales Order's source status onto
// every JO on it, however far along the JO was. The source does not see builds or QIs done in T1S,
// so a JO built and inspected here went back to In-Process: JO-72175-1-1, Qty Built 1 and Qty
// Inspected 1 of 1, read "Released In-Process" (2026-10-13). The sync is forward-only now; this
// puts back the JOs it already set back.
//
// A JO is judged from its own T1S builds and inspections, by the same rule the build and QI routes
// use (routes/production.js, routes/qualityInspections.js):
//   uninspected built qty left on a build            -> For QI
//   else all inspected and no open RFQC / RWIP       -> Completed (Invoiced if fully invoiced)
//   else something inspected                         -> Partially Completed
// and moved only FORWARD to that, never back. Partially Completed JOs are judged too (2026-10-29):
// JO-63045-1-1 had 178 of 500 built and inspected in T1S while the source read it Completed --
// after its builds and QIs are re-pulled (import-production-stages.js --only=SO-...) this moves it on. Its Sales Order is then recomputed the way the app
// does it (lib/salesOrderStatus.js), also forward only.
//
//   node src/db/fix-regressed-jo-stages.js                  # preview
//   node src/db/fix-regressed-jo-stages.js JO-72175-1-1     # preview one
//   node src/db/fix-regressed-jo-stages.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { computeSalesOrderStatus, invoicedOrTicketedSql, statusRuleReady } = require('../lib/salesOrderStatus');

const APPLY = process.argv.includes('--apply');
const ONE = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;
const n = (v) => Number(v || 0);

const STAGE_RANK = { pending_for_scheduling: 0, for_revision: 1, in_process_with_revision: 1, in_process: 2,
  for_qi: 3, partially_completed: 4, completed: 5, invoiced: 6 };
const SO_RANK = ['pending_for_jo', 'jo_in_process', 'pending_delivery', 'partially_delivered',
  'pending_billing_partially_delivered', 'pending_billing', 'partially_billed', 'billed'];

(async () => {
  await statusRuleReady;
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  // Only JOs with a T1S build: nothing else has progress the sync could have overwritten.
  const [jos] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.sales_order_id, jo.production_stage, jo.quantity, jo.quantity_built,
            jo.quantity_inspected, jo.quantity_invoiced, b.uninspected, b.rma,
            (SELECT COUNT(*) FROM job_orders r WHERE r.parent_job_order_id = jo.id AND r.status <> 'Cancelled'
                AND (r.production_stage IS NULL OR r.production_stage NOT IN ('completed','invoiced'))) AS open_rework
       FROM job_orders jo
       JOIN (SELECT job_order_id, SUM(quantity_built - passed_qty - rma_qty) AS uninspected, SUM(rma_qty) AS rma
               FROM assembly_builds WHERE status <> 'cancelled' GROUP BY job_order_id) b ON b.job_order_id = jo.id
      WHERE jo.status = 'Released' AND jo.production_stage IN ('pending_for_scheduling','for_revision','in_process_with_revision','in_process','for_qi','partially_completed')
        ${ONE ? 'AND jo.job_order_no = ?' : ''}`,
    ONE ? [ONE] : []);

  const sos = new Set();
  let changed = 0;
  for (const jo of jos) {
    let stage;
    if (n(jo.uninspected) > 1e-6) stage = 'for_qi';
    else if (n(jo.quantity_inspected) > 0 || n(jo.rma) > 0) {
      stage = n(jo.quantity_inspected) >= n(jo.quantity) && n(jo.open_rework) === 0 ? 'completed' : 'partially_completed';
      if (stage === 'completed' && n(jo.quantity) > 0 && n(jo.quantity_invoiced) >= n(jo.quantity)) stage = 'invoiced';
    } else continue;
    if (STAGE_RANK[stage] <= STAGE_RANK[jo.production_stage]) continue;
    changed += 1;
    console.log(`  ${jo.job_order_no}: ${jo.production_stage} -> ${stage}  (qty ${n(jo.quantity)}, built ${n(jo.quantity_built)}, inspected ${n(jo.quantity_inspected)})`);
    if (APPLY) await pool.query('UPDATE job_orders SET production_stage = ?, updated_at = NOW() WHERE id = ?', [stage, jo.id]);
    if (jo.sales_order_id) sos.add(jo.sales_order_id);
  }

  let soChanged = 0;
  for (const soId of sos) {
    const [[so]] = await pool.query('SELECT sales_order_no, status FROM sales_orders WHERE id = ?', [soId]);
    if (!so || so.status === 'cancelled') continue;
    const [lines] = await pool.query(
      `SELECT sol.job_order_id, sol.quantity, j.quantity_built, j.quantity_inspected, j.quantity_delivered, ${invoicedOrTicketedSql('j')}
         FROM sales_order_lines sol LEFT JOIN job_orders j ON j.id = sol.job_order_id WHERE sol.sales_order_id = ?`, [soId]);
    const next = computeSalesOrderStatus(lines);
    if (!SO_RANK.includes(so.status) || SO_RANK.indexOf(next) <= SO_RANK.indexOf(so.status)) continue;
    soChanged += 1;
    console.log(`  ${so.sales_order_no}: ${so.status} -> ${next}`);
    if (APPLY) await pool.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [next, soId]);
  }

  console.log(`${jos.length} JO(s) checked, ${changed} JO(s) and ${soChanged} Sales Order(s) ${APPLY ? 'moved forward' : 'behind their builds / QIs'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
