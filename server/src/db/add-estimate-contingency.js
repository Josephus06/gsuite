// Adds Contingency to an estimate's job order: a buffer added on top of what the processes come
// to, entered either as a percentage or as a cash amount.
//
// It sits on the JOB ORDER, not the estimate, because that is where the real system puts it --
// under the process list, above that job order's Total -- and because a quote can hold several job
// orders that each want their own allowance.
//
// TWO COLUMNS, NOT ONE. Percent and amount are each other's mirror: type 10% against a 100 base
// and the amount becomes 10; type 10 and the percent becomes 10. Storing only one and deriving the
// other on read would lose which of them the person actually typed, and the derived side would
// drift the moment a process line changed the base underneath it.
//
// The percent needs real precision. The live example carries 1.376401% -- a figure arrived at by
// entering the AMOUNT (142.56 on a base of 10,357.45) and letting the percentage fall out of it --
// so DECIMAL(9,6) keeps what was actually entered rather than rounding it to 1.38 and changing the
// money on the next recalculation.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-estimate-contingency.js
const pool = require('../db');

const COLUMNS = [
  ['contingency_percent', 'DECIMAL(9,6) NULL AFTER gp_amount'],
  ['contingency_amount', 'DECIMAL(14,2) NULL AFTER contingency_percent'],
];

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  for (const [column, ddl] of COLUMNS) {
    if (await columnExists('estimate_job_orders', column)) {
      console.log(`  estimate_job_orders.${column} already exists -- skipped.`);
    } else {
      await pool.query(`ALTER TABLE estimate_job_orders ADD COLUMN ${column} ${ddl}`);
      console.log(`  estimate_job_orders.${column} added.`);
    }
  }

  // Nothing is backfilled. A job order with no contingency has none -- that is not a gap to fill,
  // and writing 0 everywhere would make "no allowance" and "an allowance of nothing" look alike.
  const [[s]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(contingency_amount IS NOT NULL) AS withCont
       FROM estimate_job_orders`,
  );
  console.log(`\n${s.total} estimate job orders, ${Number(s.withCont) || 0} with a contingency.`);
  console.log('Sales order lines get no columns of their own: the contingency is added into the');
  console.log('job order\'s Subtotal, so the figures that flow onward already include it.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
