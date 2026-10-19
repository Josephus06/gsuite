// The NSJO process lines that could not be costed because their SIZE UNIT was not a length unit
// (backfill-nsjo-process-costs.js "needs checking", 2026-10-19): SQFT, PC, "0" or blank typed where
// the size's unit goes. Each is set to the unit its job says, then re-costed with the same formula
// (lib/joProcessCosting.js costProcessLine). Read from each job, asked to "correct all":
//
//   998191   NSJO-INT-1951-1-3  75 x 17   MM  "THI - CUTTING LASER OF1MM STAINLESS PLATE _75 X 17 MM"
//                                            (someone had set CM, which costed 100x the area)
//   995861   NSJO-SAM-2470-1-1  12 x 20   IN  colour swatches / visual proofing on backlit
//   995871   NSJO-SAM-2470-1-1  12 x 20   IN  the same job's second material
//   998121   NSJO-INT-1948-1-1  38        IN  gloss laminate, sold by the linear inch
//   999471   NSJO-INT-1957-1-1  10 x 16   IN  a grave label on 6mm acrylic
//   1003901  NSJO-INT-1969-1-1  3.5 x 6   IN  a UV-print sample
//   1007962  NSJO-SAM-2452-1-1  11.7      IN  double-loop spring for an A4 menu (A4 is 11.7 in long)
//
// Shows each line's cost before and after; writes only with --apply.
//   node src/db/fix-nsjo-size-units.js
//   node src/db/fix-nsjo-size-units.js --apply
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { costProcessLine, COST_FIELDS } = require('../lib/joProcessCosting');

const APPLY = process.argv.includes('--apply');
const UNITS = { 998191: 'MM', 995861: 'IN', 995871: 'IN', 998121: 'IN', 999471: 'IN', 1003901: 'IN', 1007962: 'IN' };
const money = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}\n`);
  const [lines] = await pool.query(
    `SELECT p.id, jo.job_order_no, p.process_cost, p.material_cost, p.total_cost, ${COST_FIELDS.map((f) => `p.${f}`).join(', ')}
       FROM job_order_processes p JOIN job_orders jo ON jo.id = p.job_order_id WHERE p.id IN (?)`, [Object.keys(UNITS).map(Number)]);
  for (const l of lines) {
    const unit = UNITS[l.id];
    const c = await costProcessLine(pool, { ...l, uom: unit });
    const tag = `${l.job_order_no} line ${l.id}: ${l.length}${l.width ? ` x ${l.width}` : ''} ${l.uom || '(blank)'} -> ${unit}`;
    if (c.needs_check) { console.log(`  ${tag}  STILL NOT COSTABLE: ${c.needs_check}`); continue; }
    console.log(`  ${tag}  process ${money(l.process_cost)} -> ${money(c.process_cost)}, material ${money(l.material_cost)} -> ${money(c.material_cost)}, total ${money(l.total_cost)} -> ${money(c.total_cost)}`);
    if (APPLY) {
      await pool.query('UPDATE job_order_processes SET uom = ?, process_cost = ?, material_cost = ?, total_cost = ? WHERE id = ?',
        [unit, c.process_cost, c.material_cost, c.total_cost, l.id]);
    }
  }
  console.log(`\n${lines.length} line(s) ${APPLY ? 'corrected' : 'would be corrected'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
