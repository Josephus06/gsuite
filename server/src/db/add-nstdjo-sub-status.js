// One-off migration: gives Non-Standard Job Orders the same status/sub_status pair Job
// Orders use, so a forwarded NSTDJO lands in the Design Supervisor's queue.
//
// The live system keeps Status at "Planned - Pending for BOM" for the whole design stage
// and moves a separate Sub Status through Pending -> For Design Supervisor -> For Artist
// (confirmed on the sandbox's System Info tab: "SubStatus | Pending | For Design
// Supervisor"). An earlier version of the forward action overwrote `status` itself with
// "Forwarded to Design Supervisor", which took those rows out of the design queue's
// status filter entirely -- this restores any of them.
//
// Idempotent -- safe to re-run:
//   node src/db/add-nstdjo-sub-status.js
const pool = require('../db');
const { DESIGN_QUEUE_STATUS } = require('../lib/designSupervisorVisibility');
require('dotenv').config();

const LEGACY_FORWARDED_STATUS = 'Forwarded to Design Supervisor';

async function main() {
  const [cols] = await pool.query('SHOW COLUMNS FROM non_standard_job_orders');
  if (cols.some((c) => c.Field === 'sub_status')) {
    console.log('sub_status already present.');
  } else {
    await pool.query(
      "ALTER TABLE non_standard_job_orders ADD COLUMN sub_status VARCHAR(50) NOT NULL DEFAULT 'Pending' AFTER status",
    );
    console.log('Added sub_status.');
  }

  // Rows the old forward action mis-stamped: put the status back and express the
  // hand-off as a sub status instead.
  const [fixed] = await pool.query(
    'UPDATE non_standard_job_orders SET status = ?, sub_status = ? WHERE status = ?',
    [DESIGN_QUEUE_STATUS, 'For Design Supervisor', LEGACY_FORWARDED_STATUS],
  );
  console.log(fixed.affectedRows
    ? `Restored ${fixed.affectedRows} row(s) from "${LEGACY_FORWARDED_STATUS}" to status="${DESIGN_QUEUE_STATUS}" / sub_status="For Design Supervisor".`
    : 'No mis-stamped rows to restore.');

  // Anything already forwarded but still showing sub_status Pending.
  const [synced] = await pool.query(
    "UPDATE non_standard_job_orders SET sub_status = 'For Design Supervisor' WHERE forwarded_at IS NOT NULL AND sub_status = 'Pending'",
  );
  if (synced.affectedRows) console.log(`Synced ${synced.affectedRows} already-forwarded row(s) to sub_status="For Design Supervisor".`);

  const [summary] = await pool.query(
    'SELECT status, sub_status, COUNT(*) AS orders FROM non_standard_job_orders GROUP BY status, sub_status',
  );
  console.log('\nNon-Standard Job Orders by status:');
  console.table(summary);

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
