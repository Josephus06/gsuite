// One-off: Job Orders already In-Process before lib/designAutoComplete.js existed still have their
// Design / Layout process lines short of 100%. The rule now completes them on the way into
// In-Process; this brings the ones already there into line. Same write, same matching.
//
//   node src/db/backfill-design-process-complete.js           # dry run: how many
//   node src/db/backfill-design-process-complete.js --apply
const pool = require('../db');
require('dotenv').config();
const { completeDesignProcesses } = require('../lib/designAutoComplete');

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN'}`);
  const [jos] = await pool.query(
    `SELECT DISTINCT jo.id, jo.job_order_no
       FROM job_order_processes jop
       JOIN job_orders jo ON jo.id = jop.job_order_id
       JOIN locations l ON l.id = COALESCE(jop.location_id, jo.job_location_id)
      WHERE jo.production_stage = 'in_process'
        AND (l.location_name LIKE '%design%' OR l.location_name LIKE '%layout%')
        AND jop.total > 0 AND COALESCE(jop.total_completed, 0) < jop.total
      ORDER BY jo.id`);
  console.log(`In-Process Job Orders with an incomplete Design / Layout line: ${jos.length}`);
  console.log(`  e.g. ${jos.slice(0, 8).map((j) => j.job_order_no).join(', ')}`);
  if (!APPLY) return;
  let lines = 0;
  for (const jo of jos) lines += await completeDesignProcesses(pool, jo.id);
  console.log(`Completed ${lines} Design / Layout line(s) on ${jos.length} Job Order(s).`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
