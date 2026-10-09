// Imported Assembly Build lines: Total Qty to Build is the MATERIAL the build used, not the pieces
// built (2026-10-09). import-production-stages.js and backfill-ab-lines.js wrote the build's piece
// count onto every line -- AB-134164 built 385,000 PC/S of JO-71510-3-3 and its paper line read
// 385,000 SHT out on the Bin Card, where the JO only needs 27,800 SHT for all 500,000.
//
// A line consumes its JO process line's Total spread over the JO's quantity, times what the build
// built -- the same figure the app's own Build writes (routes/production.js):
//     total_qty_to_build = job_order_processes.total / job_orders.quantity x assembly_builds.quantity_built
// 27,800 / 500,000 x 385,000 = 21,406 SHT.
//
// Only lines still holding the import's figure (= the build's quantity) that differ from that are
// touched; total_build moves with it. Every such build is dated before the Bin Card's 2026-10-01
// opening balance, so today's on-hand does not move -- the history before it does. GL Impact uses
// the line's stored costs, not this quantity, except to pick a costing bracket.
//
//   node src/db/fix-ab-line-material-qty.js --dry-run
//   node src/db/fix-ab-line-material-qty.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const MATCH = `abl.item_id IS NOT NULL AND ab.status <> 'cancelled' AND jo.quantity > 0
  AND ABS(abl.total_qty_to_build - ab.quantity_built) < 0.0001
  AND ABS(abl.total_qty_to_build - jop.total / jo.quantity * ab.quantity_built) > 0.0001`;
const FROM = `FROM assembly_build_lines abl
  JOIN assembly_builds ab ON ab.id = abl.assembly_build_id
  JOIN job_orders jo ON jo.id = ab.job_order_id
  JOIN job_order_processes jop ON jop.id = abl.job_order_process_id`;

async function main() {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${DRY_RUN ? 'DRY RUN' : 'APPLYING'}`);
  const [[c]] = await pool.query(`SELECT COUNT(*) n, COUNT(DISTINCT ab.id) abs, MAX(ab.date_created) last ${FROM} WHERE ${MATCH}`);
  console.log(`lines to correct ${c.n} on ${c.abs} build(s), latest dated ${c.last}`);
  const [sample] = await pool.query(
    `SELECT ab.ab_no, abl.unit, abl.total_qty_to_build AS was, ROUND(jop.total / jo.quantity * ab.quantity_built, 4) AS becomes
     ${FROM} WHERE ${MATCH} AND ab.ab_no IN ('AB-134164') LIMIT 5`);
  sample.forEach((s) => console.log(`  ${s.ab_no}: ${s.was} -> ${s.becomes} ${s.unit}`));
  if (DRY_RUN) { await pool.end(); return; }

  // In id batches, so the replicas are not handed one 400,000-row statement.
  const [[{ lo, hi }]] = await pool.query(`SELECT MIN(abl.id) lo, MAX(abl.id) hi ${FROM} WHERE ${MATCH}`);
  let done = 0;
  for (let from = Number(lo); from <= Number(hi); from += 20000) {
    const [r] = await pool.query(
      `UPDATE assembly_build_lines abl
         JOIN assembly_builds ab ON ab.id = abl.assembly_build_id
         JOIN job_orders jo ON jo.id = ab.job_order_id
         JOIN job_order_processes jop ON jop.id = abl.job_order_process_id
          SET abl.total_qty_to_build = jop.total / jo.quantity * ab.quantity_built,
              abl.total_build = jop.total / jo.quantity * ab.quantity_built
        WHERE abl.id BETWEEN ? AND ? AND ${MATCH}`, [from, from + 19999]);
    done += r.affectedRows;
  }
  console.log(`Corrected ${done} line(s).`);
  await pool.end();
}
main().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
