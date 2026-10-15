// Widens estimate_job_orders.contingency_percent from DECIMAL(9,6) to DECIMAL(14,6) (2026-10-15).
//
// DECIMAL(9,6) tops out at 999.999999%. A contingency entered as an AMOUNT can be many times the
// processes' base -- EST-210951 line 1 carried 342,867.00 on a base of 21,133.00, 1,622% -- and
// every save of that line was refused ("Out of range value"), so the amounts went back to the
// original on refresh. Fourteen digits with six decimals keeps the precision add-estimate-contingency
// chose and holds any percentage an amount can produce.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/widen-estimate-contingency-percent.js
const pool = require('../db');

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);
  const [[col]] = await pool.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'estimate_job_orders' AND column_name = 'contingency_percent'`,
  );
  if (!col) throw new Error('estimate_job_orders.contingency_percent does not exist -- run add-estimate-contingency.js first.');
  if (col.t.toLowerCase() === 'decimal(14,6)') {
    console.log('  contingency_percent is already DECIMAL(14,6) -- skipped.');
  } else {
    await pool.query('ALTER TABLE estimate_job_orders MODIFY COLUMN contingency_percent DECIMAL(14,6) NULL');
    console.log(`  contingency_percent ${col.t} -> DECIMAL(14,6).`);
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
