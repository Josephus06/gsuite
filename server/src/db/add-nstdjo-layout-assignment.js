// One-off migration: gives Non-Standard Job Orders the same layout-assignment fields Job
// Orders carry, so the Design Supervisor's "Assign Layout Job Type / Artist" modal works
// identically on both.
//
// layout_job_type_id is seeded from the order's pms_job_type_id when the supervisor first
// opens the modal -- Sales already picks a PMS Job Type at creation, and this stage starts
// from that choice rather than a blank field. It is a separate column, not a rewrite of
// pms_job_type_id, so changing it here doesn't erase what Sales originally asked for.
//
// Idempotent -- safe to re-run:
//   node src/db/add-nstdjo-layout-assignment.js
const pool = require('../db');
require('dotenv').config();

const TABLE = 'non_standard_job_orders';
const COLUMNS = [
  ['layout_job_type_id', 'ADD COLUMN layout_job_type_id BIGINT NULL AFTER pms_job_type_id'],
  ['layout_qty', 'ADD COLUMN layout_qty DECIMAL(14,4) NULL AFTER layout_job_type_id'],
  ['planned_start_at', 'ADD COLUMN planned_start_at DATETIME NULL AFTER layout_qty'],
  ['planned_end_at', 'ADD COLUMN planned_end_at DATETIME NULL AFTER planned_start_at'],
];

async function main() {
  const [existing] = await pool.query('SHOW COLUMNS FROM ??', [TABLE]);
  const have = new Set(existing.map((c) => c.Field));

  for (const [name, ddl] of COLUMNS) {
    if (have.has(name)) { console.log(`${name} already present.`); continue; }
    await pool.query(`ALTER TABLE ${TABLE} ${ddl}`);
    console.log(`Added ${name}.`);
  }

  const [after] = await pool.query('SHOW COLUMNS FROM ??', [TABLE]);
  console.log('\nLayout/assignment columns now:',
    after.map((c) => c.Field).filter((f) => /layout|planned|artist/.test(f)).join(', '));

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
