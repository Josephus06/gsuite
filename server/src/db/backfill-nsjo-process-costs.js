// Fills Process Cost / Material Cost / Total Cost on NSJO process lines saved without one
// (2026-10-19). Every NSJO raised in T1S from a Non-Standard Sales Order went in with no cost --
// lib/joProcessCosting.js now costs them on save; this fixes the ones already there, with the same
// formula the Estimate uses (shared/costing.js), at today's Process Costing and average costs.
//
//   --zero      also the imported NSJO lines that came over with a cost of exactly 0 (default: only
//               lines with NO cost, i.e. those made in T1S)
//   --check     costs lines that already HAVE a cost and reports how many the formula reproduces --
//               a sanity check, writes nothing
//   --dry-run   report only
//
//   node src/db/backfill-nsjo-process-costs.js --check
//   node src/db/backfill-nsjo-process-costs.js --dry-run [--zero]
//   node src/db/backfill-nsjo-process-costs.js [--zero]
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { costProcessLine, COST_FIELDS } = require('../lib/joProcessCosting');

const DRY = process.argv.includes('--dry-run');
const ZERO = process.argv.includes('--zero');
const CHECK = process.argv.includes('--check');
const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY || CHECK ? ' -- nothing will be written' : ''}\n`);
  const cols = `p.id, p.job_order_id, jo.job_order_no, p.process_cost, p.material_cost, p.total_cost, ${COST_FIELDS.map((f) => `p.${f}`).join(', ')}`;

  if (CHECK) {
    const [rows] = await pool.query(
      `SELECT ${cols} FROM job_order_processes p JOIN job_orders jo ON jo.id = p.job_order_id
        WHERE jo.job_order_no LIKE 'NSJO%' AND p.total_cost > 0 ORDER BY p.id DESC LIMIT 400`);
    let match = 0; const misses = [];
    for (const r of rows) {
      const c = await costProcessLine(pool, r);
      if (Math.abs(Number(c.total_cost || 0) - Number(r.total_cost)) < 0.02) match += 1;
      else if (misses.length < 8) misses.push(`${r.job_order_no} line ${r.id}: stored ${money(r.total_cost)}, formula ${money(c.total_cost)}`);
    }
    console.log(`Formula reproduces ${match} of ${rows.length} costed NSJO lines.`);
    misses.forEach((m) => console.log(`  ${m}`));
    await pool.end();
    return;
  }

  const [lines] = await pool.query(
    `SELECT ${cols} FROM job_order_processes p JOIN job_orders jo ON jo.id = p.job_order_id
      WHERE jo.job_order_no LIKE 'NSJO%' AND (p.total_cost IS NULL ${ZERO ? 'OR p.total_cost = 0' : ''})
      ORDER BY p.job_order_id, p.line_no`);
  const jos = new Set(); let costed = 0; let stillNone = 0; let sum = 0;
  for (const l of lines) {
    const c = await costProcessLine(pool, l);
    jos.add(l.job_order_id);
    if (c.total_cost) { costed += 1; sum += Number(c.total_cost); } else stillNone += 1;
    if (!DRY) {
      await pool.query('UPDATE job_order_processes SET process_cost = ?, material_cost = ?, total_cost = ? WHERE id = ?',
        [c.process_cost, c.material_cost, c.total_cost, l.id]);
    }
  }
  console.log(`${DRY ? 'Would cost' : 'Costed'} ${lines.length} line(s) on ${jos.size} NSJO(s)${ZERO ? ' (no cost, and zero)' : ' (no cost)'}.`);
  console.log(`  with a cost now: ${costed} line(s), ${money(sum)} in all`);
  console.log(`  still no cost:   ${stillNone} line(s) -- their process has no Process Costing bracket for the quantity, and no item`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
