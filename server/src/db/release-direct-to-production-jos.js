// Release Job Orders of a Direct to Production job type that were created before that rule existed
// (lib/directToProduction.js, 2026-10-08) and are still waiting for Design: sub status Pending, or
// For Design Supervisor with no artist yet. They move to Released / Approved / Pending for
// Scheduling, exactly as a JO created now would, each change logged on the JO.
//
// Left alone: any with an artist assigned (design work has started), any already in Production,
// and cancelled ones.
//
//   node src/db/release-direct-to-production-jos.js            # preview
//   node src/db/release-direct-to-production-jos.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { releaseIfDirectToProduction } = require('../lib/directToProduction');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [[admin]] = await pool.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1");
  const [jos] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.job_type_id, jo.status, jo.sub_status, jt.display_name AS job_type
       FROM job_orders jo JOIN job_types jt ON jt.id = jo.job_type_id
      WHERE jt.is_direct_to_prod = 1
        AND jo.production_stage IS NULL
        AND jo.status = 'Planned - Pending for BOM'
        AND jo.sub_status IN ('Pending', 'For Design Supervisor')
        AND jo.artist_id IS NULL
      ORDER BY jo.id`);
  for (const j of jos) console.log(`  ${j.job_order_no} (${j.job_type}): ${j.status} / ${j.sub_status} -> Released / Approved / Pending for Scheduling`);
  if (APPLY && jos.length) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const j of jos) {
        await releaseIfDirectToProduction(conn, {
          jobOrderId: j.id, jobTypeId: j.job_type_id, userId: admin.id, fromStatus: j.status, fromSubStatus: j.sub_status,
        });
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  console.log(`${jos.length} job order(s) ${APPLY ? 'released' : 'would be released'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
