// Job Orders fully built AND inspected whose stage still reads an earlier step -- none, Pending for
// Scheduling, For Revision, In-Process (w/ Revision) or For QI -- are set to Completed (asked
// 2026-10-21: JO-71094-3-4 and -4-4, 1 of 1 built and inspected, SO-71094 billed, read In-Process
// while their sister JOs read Completed). They came from the source with their quantities and no
// build / inspection in T1S, so nothing here ever moved their stage on. Partially Completed and
// later stages are left alone. Each change is audit-logged.
//
//   node src/db/fix-inspected-jo-stages.js                      preview
//   node src/db/fix-inspected-jo-stages.js --apply --by=<user id>
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const byArg = process.argv.find((a) => a.startsWith('--by='));
const BY = byArg ? Number(byArg.split('=')[1]) : 1;
const EARLY = ['pending_for_scheduling', 'for_revision', 'in_process_with_revision', 'in_process', 'for_qi'];

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- PREVIEW (add --apply to write)'}\n`);
  const [rows] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.production_stage, jo.quantity, jo.quantity_built, jo.quantity_inspected, so.sales_order_no, so.status AS so_status
       FROM job_orders jo LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
      WHERE jo.status <> 'Cancelled' AND jo.quantity > 0
        AND jo.quantity_built >= jo.quantity AND jo.quantity_inspected >= jo.quantity
        AND (jo.production_stage IS NULL OR jo.production_stage IN (?))
      ORDER BY jo.job_order_no`, [EARLY]);
  for (const r of rows) {
    console.log(`${r.job_order_no}: ${r.production_stage || '(none)'} -> completed   qty ${Number(r.quantity)}, built ${Number(r.quantity_built)}, inspected ${Number(r.quantity_inspected)}   ${r.sales_order_no || ''} ${r.so_status || ''}`);
    if (!APPLY) continue;
    await pool.query("UPDATE job_orders SET production_stage = 'completed', updated_at = NOW() WHERE id = ?", [r.id]);
    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('JobOrder', ?, 'Updated', 'production_stage', ?, 'completed -- fully built and inspected (fix-inspected-jo-stages.js)', ?)`,
      [r.id, r.production_stage, BY]);
  }
  console.log(`\n${APPLY ? 'Set' : 'Would set'} ${rows.length} job order(s) to Completed.`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
