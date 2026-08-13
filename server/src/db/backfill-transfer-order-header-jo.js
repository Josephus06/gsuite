// Sets transfer_orders.job_order_id from the order's own lines.
//
// The Transfer Orders LIST shows a "Job Order" column and its search box filters on the job
// order number, and both read the HEADER column -- routes/transferOrders.js joins
// `job_orders jo ON jo.id = t.job_order_id`. The import only ever populated the LINE column,
// so the list showed a dash on every row and searching by JO number matched nothing, even
// though the detail page displayed the job order correctly per line.
//
// Live has no job order FK on the transfer order header at all, so the value is derived: a
// transfer order raised for one job order gets that job order. 25,084 of 38,190 orders have
// exactly one distinct job order across their lines. The remaining 555 span two or more (one
// spans 38), and those are deliberately left NULL -- showing one of several on the list would
// be worse than showing none, and the detail page lists the real job order per line either way.
//
// Pure SQL, no live calls. IDEMPOTENT: only fills rows that are still NULL.
//
//   node src/db/backfill-transfer-order-header-jo.js
const pool = require('../db');
require('dotenv').config();

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [[before]] = await pool.query(
    'SELECT COUNT(*) AS n, SUM(job_order_id IS NOT NULL) AS w FROM transfer_orders'
  );
  console.log(`Before: ${before.w} of ${before.n} order(s) carry a job order.`);

  const [r] = await pool.query(`
    UPDATE transfer_orders t
      JOIN (
        SELECT transfer_order_id, MIN(job_order_id) AS job_order_id
          FROM transfer_order_lines
         WHERE job_order_id IS NOT NULL
         GROUP BY transfer_order_id
        HAVING COUNT(DISTINCT job_order_id) = 1
      ) x ON x.transfer_order_id = t.id
       SET t.job_order_id = x.job_order_id
     WHERE t.job_order_id IS NULL`);
  console.log(`Set on ${r.affectedRows} order(s).`);

  const [[after]] = await pool.query(
    'SELECT COUNT(*) AS n, SUM(job_order_id IS NOT NULL) AS w FROM transfer_orders'
  );
  const [[multi]] = await pool.query(`
    SELECT COUNT(*) AS n FROM (
      SELECT transfer_order_id FROM transfer_order_lines WHERE job_order_id IS NOT NULL
       GROUP BY transfer_order_id HAVING COUNT(DISTINCT job_order_id) > 1
    ) x`);
  console.log(`After:  ${after.w} of ${after.n} order(s) carry a job order.`);
  console.log(`${multi.n} order(s) span several job orders and are left blank on purpose.`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
