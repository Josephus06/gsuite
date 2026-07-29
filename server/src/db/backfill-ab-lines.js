// Assembly-build lines are built from each JO's job_order_processes (see import-production-
// stages.js). If production-stages ran BEFORE import-jo-processes populated those processes,
// the assembly_builds got created with zero lines (that ordering happened for the Sales-2
// import). This backfills the missing lines for any AB that has none, straight from the JO's
// now-present processes -- no live fetch -- mirroring import-production-stages.js exactly.
//
//   node src/db/backfill-ab-lines.js --dry-run
//   node src/db/backfill-ab-lines.js
const pool = require('../db');
require('dotenv').config();
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- nothing written.\n' : 'APPLYING.\n');

  // Assembly builds that have no lines but whose JO does have processes to build them from.
  const [abs] = await pool.query(
    `SELECT ab.id, ab.job_order_id, ab.quantity_built
       FROM assembly_builds ab
       JOIN job_orders jo ON jo.id = ab.job_order_id
      WHERE ab.status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM assembly_build_lines abl WHERE abl.assembly_build_id = ab.id)
        AND EXISTS (SELECT 1 FROM job_order_processes jop WHERE jop.job_order_id = ab.job_order_id)`);
  console.log(`Assembly builds with no lines but with JO processes: ${abs.length}`);
  if (DRY_RUN || !abs.length) { console.log(DRY_RUN ? '\nDRY RUN -- nothing written.' : 'Nothing to do.'); await pool.end(); return; }

  // Preload each JO's processes once.
  const joIds = [...new Set(abs.map((a) => a.job_order_id))];
  const procsByJo = new Map();
  const [procs] = await pool.query(
    `SELECT job_order_id, id, process_id, item_id, location_id, category, parts, process_qty, qty, unit,
            process_cost, material_cost, total_cost
       FROM job_order_processes WHERE job_order_id IN (?)`, [joIds]);
  for (const p of procs) { if (!procsByJo.has(p.job_order_id)) procsByJo.set(p.job_order_id, []); procsByJo.get(p.job_order_id).push(p); }

  let abDone = 0, linesInserted = 0;
  for (const ab of abs) {
    const jps = procsByJo.get(ab.job_order_id) || [];
    if (!jps.length) continue;
    const qty = Number(ab.quantity_built) || 0;
    const rows = jps.map((p) => [
      ab.id, p.id, p.process_id, p.item_id, p.location_id, p.category, p.parts, p.process_qty, p.qty,
      qty, qty, qty, p.unit, p.process_cost, p.material_cost, p.total_cost,
    ]);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO assembly_build_lines
           (assembly_build_id, job_order_process_id, process_id, item_id, location_id, category, parts, process_qty, qty,
            total_qty_to_build, total_completed, total_build, unit, process_cost, material_cost, total_cost)
         VALUES ?`, [rows]);
      await conn.commit();
      abDone += 1; linesInserted += rows.length;
    } catch (e) { await conn.rollback(); console.error(`  [error] AB ${ab.id}: ${e.message}`); }
    finally { conn.release(); }
  }
  console.log(`\nDone. Backfilled ${abDone} assembly build(s) with ${linesInserted} line(s).`);
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
