// Re-works a job order's Process Cost from its process's Costing brackets with T1S's own formula,
// (SubTotal + Total Sub Con) x Process Qty (shared/costing.js, set 2026-10-27). A JO imported from
// the source keeps the source's own figures (import-jo-processes.js), which do not follow it --
// JO-198481-2-6 had 1,350.00 for 10 CBM and 238.00 for 96 CBM of the same process.
//
// Material Cost is left as it is; Total Cost = the new Process Cost + Material Cost. A line whose
// process has no bracket for its Process Qty is reported and left alone.
//
//   node src/db/recost-jo-processes.js --jo=JO-198481-2-6            report (default)
//   node src/db/recost-jo-processes.js --jo=JO-198481-2-6 --apply
//   node src/db/recost-jo-processes.js --so=SO-198481 --apply         every JO of the sales order
//
// Run it against ONE box of the droplet/office pair; replication carries it to the other.
require('dotenv').config();
const pool = require('../db');
const { costing } = require('../lib/costing');

const APPLY = process.argv.includes('--apply');
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;
const JO = arg('jo');
const SO = arg('so');
const money = (v) => (v == null ? '-' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

async function main() {
  if (!JO && !SO) throw new Error('Give --jo=<JO number> or --so=<SO number>');
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'REPORT ONLY'}`);
  const { computeAutoPricing } = await costing();

  const [jos] = JO
    ? await pool.query('SELECT id, job_order_no FROM job_orders WHERE job_order_no = ?', [JO])
    : await pool.query(
      `SELECT jo.id, jo.job_order_no FROM job_orders jo JOIN sales_orders so ON so.id = jo.sales_order_id
        WHERE so.sales_order_no = ? ORDER BY jo.job_order_no`, [SO]);
  if (!jos.length) throw new Error(`No job order found for ${JO || SO}`);

  let changed = 0;
  for (const jo of jos) {
    console.log(`\n${jo.job_order_no}`);
    const [lines] = await pool.query(
      `SELECT p.id, p.line_no, p.process_id, p.process_qty, p.qty, p.process_cost, p.material_cost, p.total_cost, pr.process_name
         FROM job_order_processes p LEFT JOIN processes pr ON pr.id = p.process_id
        WHERE p.job_order_id = ? ORDER BY p.line_no, p.id`, [jo.id]);
    let before = 0;
    let after = 0;
    for (const l of lines) {
      const [brackets] = l.process_id
        ? await pool.query('SELECT * FROM process_cost_brackets WHERE process_id = ? AND is_active = 1 ORDER BY qty_min', [l.process_id])
        : [[]];
      const c = computeAutoPricing({ brackets, inventory: null, processQty: l.process_qty, qty: l.qty });
      const label = `  ${String(l.line_no).padStart(2)} ${String(l.process_name || '(no process)').slice(0, 48).padEnd(48)} qty ${String(Number(l.process_qty)).padStart(6)}`;
      before += Number(l.total_cost) || 0;
      if (c.process_cost == null) {
        after += Number(l.total_cost) || 0;
        console.log(`${label}  ${money(l.process_cost)} -- no bracket for this qty, left alone`);
        continue;
      }
      const total = Number((c.process_cost + (Number(l.material_cost) || 0)).toFixed(2));
      after += total;
      const same = Math.abs(Number(l.process_cost) - c.process_cost) < 0.005;
      console.log(`${label}  ${money(l.process_cost)} -> ${money(c.process_cost)}${same ? '' : '   *'}`);
      if (APPLY && !same) {
        await pool.query('UPDATE job_order_processes SET process_cost = ?, total_cost = ? WHERE id = ?', [c.process_cost, total, l.id]);
        changed += 1;
      }
    }
    console.log(`  Total Cost ${money(before)} -> ${money(after)}`);
  }
  console.log(APPLY ? `\nUpdated ${changed} line(s).` : '\nREPORT ONLY -- nothing written. Re-run with --apply.');
}

main()
  .catch((e) => { console.error('ERR', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
