// NSJO (RMA job order) approval: a JO created from a Non-Standard Sales Order starts in
// "Pending RMA Approval" and only flows into production once someone with NSSO-approve
// permission approves it. These columns record that approval (NULL for ordinary JOs).
const pool = require('../db');

async function columnExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}

(async () => {
  try {
    if (!(await columnExists('job_orders', 'rma_approved_at'))) {
      await pool.query('ALTER TABLE job_orders ADD COLUMN rma_approved_at DATETIME NULL');
      console.log('Added job_orders.rma_approved_at');
    } else console.log('job_orders.rma_approved_at already exists');

    if (!(await columnExists('job_orders', 'rma_approved_by_id'))) {
      await pool.query('ALTER TABLE job_orders ADD COLUMN rma_approved_by_id INT NULL');
      console.log('Added job_orders.rma_approved_by_id');
    } else console.log('job_orders.rma_approved_by_id already exists');

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
