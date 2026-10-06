// A Job Order's Qty Inspected should be what its saved Quality Inspections passed, plus what its
// completed RFQC rework orders credited back (see routes/qualityInspections.js). JO-72341-17-18 read
// 12 inspected against one QI passing 6 (2026-10-06). This lists every JO whose figure disagrees with
// its QIs and, with --apply, sets it back -- along with Completed / Partially Completed to match.
//
// Only JOs whose live QIs were all saved in T1S (status 'saved') are judged. A QI migrated from the
// source is 'completed', and those carry their lines twice on thousands of JOs (QI-107643: two lines
// of 10,000 for one 10,000 inspection) -- measuring against them would double the JO instead.
//
//   node src/db/fix-jo-qty-inspected.js                    # preview, every JO
//   node src/db/fix-jo-qty-inspected.js JO-72341-17-18     # preview one, with its QIs
//   node src/db/fix-jo-qty-inspected.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const ONE = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;
const n = (v) => Number(v || 0);

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [jos] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.quantity, jo.quantity_built, jo.quantity_inspected, jo.production_stage,
            p.passed, COALESCE(r.rfqc_back, 0) AS rfqc_back
       FROM (SELECT qi.job_order_id, SUM(qil.pass_qty) AS passed
               FROM quality_inspections qi JOIN quality_inspection_lines qil ON qil.quality_inspection_id = qi.id
              WHERE qi.status <> 'cancelled' GROUP BY qi.job_order_id
             HAVING SUM(qi.status <> 'saved') = 0) p
       JOIN job_orders jo ON jo.id = p.job_order_id
       LEFT JOIN (SELECT parent_job_order_id, SUM(quantity) AS rfqc_back FROM job_orders
                   WHERE job_order_no LIKE 'RFQC-%' AND production_stage IN ('completed', 'invoiced')
                   GROUP BY parent_job_order_id) r ON r.parent_job_order_id = jo.id
      ${ONE ? 'WHERE jo.job_order_no = ?' : ''}`,
    ONE ? [ONE] : []);

  let changed = 0;
  for (const jo of jos) {
    const expected = n(jo.passed) + n(jo.rfqc_back);
    if (ONE) {
      const [qis] = await pool.query(
        `SELECT qi.qi_no, qi.status, qi.created_at, SUM(qil.pass_qty) AS pass, SUM(qil.rma_qty) AS rma
           FROM quality_inspections qi LEFT JOIN quality_inspection_lines qil ON qil.quality_inspection_id = qi.id
          WHERE qi.job_order_id = ? GROUP BY qi.id ORDER BY qi.id`, [jo.id]).catch(async () => [[]]);
      console.log(`${jo.job_order_no}: qty ${n(jo.quantity)}, built ${n(jo.quantity_built)}, inspected ${n(jo.quantity_inspected)} (stage ${jo.production_stage})`);
      for (const q of qis) console.log(`   ${q.qi_no || '(QI)'} ${q.status} ${String(q.created_at).slice(0, 24)} pass ${n(q.pass)} rma ${n(q.rma)}`);
      console.log(`   expected inspected = passed ${n(jo.passed)} + completed RFQC ${n(jo.rfqc_back)} = ${expected}`);
    }
    if (Math.abs(expected - n(jo.quantity_inspected)) < 1e-6) continue;
    changed += 1;
    // Stage follows only between the two inspected stages; anything further along (delivered,
    // invoiced) is left as it is.
    let stage = jo.production_stage;
    if (['completed', 'partially_completed'].includes(stage)) stage = expected >= n(jo.quantity) ? 'completed' : 'partially_completed';
    console.log(`  ${jo.job_order_no}: inspected ${n(jo.quantity_inspected)} -> ${expected}${stage !== jo.production_stage ? ` (stage ${jo.production_stage} -> ${stage})` : ''}`);
    if (APPLY) {
      await pool.query('UPDATE job_orders SET quantity_inspected = ?, production_stage = ?, updated_at = NOW() WHERE id = ?', [expected, stage, jo.id]);
    }
  }
  console.log(`${jos.length} JO(s) with a QI checked, ${changed} ${APPLY ? 'corrected' : 'disagree with their QIs'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
