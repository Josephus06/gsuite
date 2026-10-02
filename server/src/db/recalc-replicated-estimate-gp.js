// Recalculate the GP of estimates made with Replicate, from their own process lines.
//
// Replicate used to copy each job line's GP verbatim, so a replica of a migrated estimate carried
// the old system's GP and could "pass" on it (EST-203231). Replicate now recalculates
// (lib/estimateGp.js); this brings the replicas made before that in line.
//
// Only replicas still Pending Supervisor Approval are touched. An estimate a supervisor has
// signed off has been approved on the figures it showed, and the commission report reads its GP;
// changing those after the fact is a different decision.
//
//   node src/db/recalc-replicated-estimate-gp.js            dry run
//   node src/db/recalc-replicated-estimate-gp.js --apply
//
// Run on ONE box of the droplet/office pair; replication carries it to the other.
require('dotenv').config();
const pool = require('../db');
const { recalcEstimateGp } = require('../lib/estimateGp');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN'}`);
  const [ests] = await pool.query(
    `SELECT e.id, e.estimate_no, e.est_gp_rate, a.new_value AS replicated_from
       FROM estimates e
       JOIN audit_logs a ON a.auditable_type = 'Estimate' AND a.auditable_id = e.id
                        AND a.event_type = 'Created' AND a.field_name = 'replicated_from'
      WHERE e.status = 'pending_supervisor_approval'
      ORDER BY e.id`);
  console.log(`Replicated estimates pending supervisor approval: ${ests.length}`);

  let changedEstimates = 0, changedLines = 0;
  for (const e of ests) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const changes = await recalcEstimateGp(conn, e.id);
      const [[after]] = await conn.query('SELECT est_gp_rate FROM estimates WHERE id = ?', [e.id]);
      if (changes.length) {
        changedEstimates += 1;
        changedLines += changes.length;
        console.log(`  ${e.estimate_no} (from ${e.replicated_from}): ${changes.length} line(s) -- `
          + `${changes.map((c) => `${c.from ?? '-'}% -> ${c.to ?? '-'}%`).join(', ')}; overall ${e.est_gp_rate}% -> ${after.est_gp_rate}%`);
      }
      if (APPLY) await conn.commit(); else await conn.rollback();
    } catch (err) {
      await conn.rollback();
      console.warn(`  !! ${e.estimate_no}: ${err.message}`);
    } finally {
      conn.release();
    }
  }
  console.log(`\n${changedEstimates} estimate(s), ${changedLines} line(s) ${APPLY ? 'recalculated' : 'would be recalculated'}.`);
  if (!APPLY) console.log('DRY RUN -- nothing written. Re-run with --apply.');
})()
  .catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
