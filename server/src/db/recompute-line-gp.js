// The sales import stored per-line GP from the live estimate ledger's GPRate_LdgrJob field,
// which is often null -> stored as 0, so the per-JO "GP Rate" column reads 0% / is wrong.
// Live never stores the per-JO GP (it computes it in the browser), so we reproduce the actual
// GP from the production costs we imported into job_order_processes:
//
//   gp_rate  = (net_of_tax - production_cost) / net_of_tax * 100
//   gp_amount = net_of_tax - production_cost
//   production_cost = SUM(job_order_processes.avg_cost) for the line's job order
//     (avg_cost = live Cost_LdgrInvty, the average unit cost -- the basis that reconciles to
//      the live-stored SO-level GP and matches completed JOs; total_cost overstated cost.)
//
// This matches the live SO page's GP concept and is exact for fully-completed JOs (a single
// SERVICE line JO like MOBILIZATION reconciles to the live 80.00%).
//
// SCOPE: only lines whose stored gp_rate is 0 / NULL are recomputed. A non-zero stored value
// came from the live estimate ledger's GPRate_LdgrJob field (live stores + displays it directly
// for those estimates) and is authoritative -- we preserve it. Live only computes GP on the fly
// (leaving GPRate_LdgrJob null) for estimates where our import stored 0; those are the ones we fill.
// Pass --all to instead recompute every line with process costs (overriding stored values).
//
//   node src/db/recompute-line-gp.js --dry-run
//   node src/db/recompute-line-gp.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all');
const r2 = (n) => Math.round(n * 100) / 100;

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING.\n');

  // Per-line net_of_tax + summed production cost from its job order's process lines.
  const [rows] = await pool.query(
    `SELECT sol.id, sol.net_of_tax, sol.gp_rate AS old_rate,
            so.sales_order_no,
            SUM(jop.avg_cost) AS prod_cost, COUNT(jop.id) AS proc_lines
       FROM sales_order_lines sol
       JOIN sales_orders so ON so.id = sol.sales_order_id
       JOIN job_orders jo ON jo.id = sol.job_order_id
       JOIN job_order_processes jop ON jop.job_order_id = jo.id
      ${ALL ? '' : 'WHERE (sol.gp_rate = 0 OR sol.gp_rate IS NULL)'}
      GROUP BY sol.id`
  );
  console.log(`${ALL ? 'ALL mode: ' : 'zero/null gp_rate only: '}${rows.length} line(s) to recompute.`);

  const dist = { neg: 0, '0-30': 0, '30-50': 0, '50-70': 0, '70-100': 0 };
  const samples = {};
  let updated = 0;
  for (const row of rows) {
    const net = Number(row.net_of_tax) || 0;
    const cost = Number(row.prod_cost) || 0;
    if (net <= 0) continue;
    const rate = r2((net - cost) / net * 100);
    const amount = r2(net - cost);
    if (rate < 0) dist.neg += 1; else if (rate < 30) dist['0-30'] += 1; else if (rate < 50) dist['30-50'] += 1; else if (rate < 70) dist['50-70'] += 1; else dist['70-100'] += 1;
    if (['SO-64642', 'SO-70406'].includes(row.sales_order_no)) (samples[row.sales_order_no] ??= []).push({ net, cost: r2(cost), old: row.old_rate, new: rate });
    if (!DRY_RUN) { await pool.query('UPDATE sales_order_lines SET gp_rate = ?, gp_amount = ? WHERE id = ?', [rate, amount, row.id]); }
    updated += 1;
  }

  console.log('\nNew gp_rate distribution:');
  Object.entries(dist).forEach(([k, v]) => console.log(`  ${k}%: ${v}`));
  console.log('\nSample SOs (net / cost / old rate -> new rate):');
  for (const [so, lines] of Object.entries(samples)) { console.log(`  ${so}:`); lines.forEach((l) => console.log(`    net=${l.net} cost=${l.cost} ${l.old}% -> ${l.new}%`)); }
  console.log(`\n${DRY_RUN ? 'Would update' : 'Updated'} ${updated} line(s).`);
  if (DRY_RUN) console.log('\nDRY RUN -- nothing written.');
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
