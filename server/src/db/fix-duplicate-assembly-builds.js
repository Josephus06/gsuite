// Undo Assembly Builds saved twice by a double submit (2026-10-21: JO-199661-1-1 got AB-354253 and
// AB-354256 in the same second). The build check ran outside the transaction, so both requests saw
// nothing built and both went through: material taken twice, each process line's Total Built doubled
// -- but the JO's own Qty Built written, not added, so it reads right (1, not 2). routes/production.js
// now locks the JO; this cleans up what got through before.
//
// A duplicate: another live build on the same JO, by the same user, saved within 10 seconds, while
// the JO's Qty Built is LESS than the builds add up to. Of each such group the builds beyond what the
// JO's Qty Built accounts for are undone -- the latest first, never one a live Quality Inspection
// points at. Undoing one puts its material back (stock items only), takes its quantity off each
// process line's Total Built, and marks it cancelled. The JO's Qty Built is NOT reduced: it already
// counts only one (the regular Cancel would take it to 0, below what has been inspected).
//
//   node src/db/fix-duplicate-assembly-builds.js             preview
//   node src/db/fix-duplicate-assembly-builds.js --apply --by=<user id>
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { isNonStockItem } = require('../lib/itemTypes');

const APPLY = process.argv.includes('--apply');
const byArg = process.argv.find((a) => a.startsWith('--by='));
const BY = byArg ? Number(byArg.split('=')[1]) : 1;

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- PREVIEW (add --apply to write)'}\n`);
  const [pairs] = await pool.query(
    `SELECT DISTINCT a.job_order_id
       FROM assembly_builds a JOIN assembly_builds b
         ON b.job_order_id = a.job_order_id AND b.id > a.id AND b.status <> 'cancelled'
        AND b.created_by_user_id <=> a.created_by_user_id
        AND ABS(TIMESTAMPDIFF(SECOND, a.created_at, b.created_at)) <= 10
      WHERE a.status <> 'cancelled'`);
  let undone = 0;
  for (const { job_order_id: joId } of pairs) {
    const [[jo]] = await pool.query('SELECT id, job_order_no, quantity, quantity_built FROM job_orders WHERE id = ?', [joId]);
    const [abs] = await pool.query(
      `SELECT ab.id, ab.ab_no, ab.quantity_built, ab.created_at,
              EXISTS(SELECT 1 FROM quality_inspection_lines l JOIN quality_inspections q ON q.id = l.quality_inspection_id
                      WHERE l.assembly_build_id = ab.id AND q.status <> 'cancelled') AS inspected
         FROM assembly_builds ab WHERE ab.job_order_id = ? AND ab.status <> 'cancelled' ORDER BY ab.id`, [joId]);
    let excess = abs.reduce((s, a) => s + Number(a.quantity_built), 0) - Number(jo.quantity_built || 0);
    if (excess <= 0) continue; // the JO counts every build -- not a lost duplicate
    for (const ab of [...abs].reverse()) {
      if (excess <= 0) break;
      if (Number(ab.inspected) || Number(ab.quantity_built) > excess) continue;
      const [lines] = await pool.query(
        `SELECT l.job_order_process_id, l.item_id, l.location_id, l.total_qty_to_build, i.item_type, i.display_name
           FROM assembly_build_lines l LEFT JOIN inventories i ON i.id = l.item_id WHERE l.assembly_build_id = ?`, [ab.id]);
      console.log(`${jo.job_order_no}: undo ${ab.ab_no} (built ${Number(ab.quantity_built)}; JO Qty Built ${Number(jo.quantity_built)} stays)`);
      for (const l of lines) {
        if (!l.item_id || !l.location_id || !Number(l.total_qty_to_build)) continue;
        console.log(`   ${isNonStockItem(l.item_type) ? 'Total Built only' : 'return to stock'}  ${Number(l.total_qty_to_build)}  ${l.display_name}`);
      }
      excess -= Number(ab.quantity_built);
      undone += 1;
      if (!APPLY) continue;
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        for (const l of lines) {
          if (!l.item_id || !l.location_id || !Number(l.total_qty_to_build)) continue;
          if (!isNonStockItem(l.item_type)) {
            await conn.query('UPDATE inventory_locations SET qty_on_hand = qty_on_hand + ? WHERE inventory_id = ? AND location_id = ?',
              [l.total_qty_to_build, l.item_id, l.location_id]);
          }
          await conn.query('UPDATE job_order_processes SET total_built = total_built - ? WHERE id = ?', [l.total_qty_to_build, l.job_order_process_id]);
        }
        await conn.query(
          "UPDATE assembly_builds SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = NOW(), updated_at = NOW(), memo = CONCAT_WS(' -- ', NULLIF(memo, ''), 'Duplicate of a double submit, undone (fix-duplicate-assembly-builds.js)') WHERE id = ?",
          [BY, ab.id]);
        await conn.query(
          `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
           VALUES ('AssemblyBuild', ?, 'Cancelled', 'status', 'saved', 'cancelled -- duplicate of a double submit (fix-duplicate-assembly-builds.js)', ?)`,
          [ab.id, BY]);
        await conn.commit();
      } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    }
  }
  console.log(`\n${APPLY ? 'Undid' : 'Would undo'} ${undone} duplicate build(s) on ${pairs.length} job order(s) checked.`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
