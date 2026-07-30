// Internal Non-Standard Sales Orders create job orders with NO originating Sales Order (the work
// is raised directly, not off an SO line). job_orders.sales_order_id / sales_order_line_id were
// NOT NULL because every JO used to come from an SO line -- relax them so an internal-NSSO JO can
// exist without one. Existing rows are unaffected.
const pool = require('../db');

(async () => {
  try {
    await pool.query('ALTER TABLE job_orders MODIFY COLUMN sales_order_id BIGINT NULL');
    console.log('job_orders.sales_order_id -> NULL');
    await pool.query('ALTER TABLE job_orders MODIFY COLUMN sales_order_line_id BIGINT NULL');
    console.log('job_orders.sales_order_line_id -> NULL');
    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
