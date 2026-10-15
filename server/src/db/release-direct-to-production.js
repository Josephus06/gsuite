// Job orders of a Direct to Production job type that are still waiting in Design because they were
// made before the type was ticked (asked 2026-10-15: CNC-ACCESSORIES, NSSO-INT-1951 / -1963). Saving
// a job type with the box newly ticked now releases its own (routes/jobTypes.js); this does it for
// the types already ticked. Lists them unless --apply.
//
//   node src/db/release-direct-to-production.js                 # every Direct to Production type
//   node src/db/release-direct-to-production.js CNC-ACCESSORIES # one type, by name
//   node src/db/release-direct-to-production.js --apply
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { releaseWaitingForJobType } = require('../lib/directToProduction');

const APPLY = process.argv.includes('--apply');
const NAME = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [types] = await pool.query(
    `SELECT id, display_name FROM job_types WHERE is_direct_to_prod = 1 ${NAME ? 'AND display_name = ?' : ''} ORDER BY display_name`,
    NAME ? [NAME] : []);
  // Recorded as the first System Admin, since a script has no logged-in user.
  const [[admin]] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = 1 ORDER BY id LIMIT 1");
  let total = 0;
  for (const t of types) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const nos = await releaseWaitingForJobType(conn, t.id, admin?.id || null, { dryRun: !APPLY });
      await conn.commit();
      if (nos.length) console.log(`  ${t.display_name}: ${APPLY ? 'released' : 'would release'} ${nos.length} -- ${nos.join(', ')}`);
      total += nos.length;
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  console.log(`${total} job order(s) ${APPLY ? 'sent to Production (Pending for Scheduling)' : 'waiting in Design'} across ${types.length} Direct to Production type(s).`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
