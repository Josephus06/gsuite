// RWIP (Rework-In-Progress) job orders are raised from a mother Job Order that's already in
// production, to redo/rework part of it. An RWIP is itself a job_orders row (number RWIP-###)
// that links back to the JO it reworks via parent_job_order_id. It reuses the RMA approval
// columns (rma_approved_at / rma_approved_by_id, added earlier) for its "Pending RMA Approval".
const pool = require('../db');

async function colExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}

(async () => {
  try {
    if (!(await colExists('job_orders', 'parent_job_order_id'))) {
      await pool.query('ALTER TABLE job_orders ADD COLUMN parent_job_order_id BIGINT NULL');
      console.log('Added job_orders.parent_job_order_id');
    } else console.log('job_orders.parent_job_order_id exists');
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
