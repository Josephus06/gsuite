// Lets a Commission Voucher expense on Commission Payable (24200) be pointed at a specific
// month, so it adjusts that month's Released Commission directly.
//
// WHY. An expense on a voucher is currently either a deduction (negative) or a refund
// (positive), and neither can settle an overpayment. A refund adds to Released and takes the
// same amount off Deducted, so `unpaid = confirmed - (released + deducted)` does not move at
// all -- it only shuffles the two columns:
//
//   January before:  released 5,163.66 + deducted 2,000.00 = 7,163.66  -> unpaid -419.55
//   as a refund:     released 5,579.21 + deducted 1,584.45 = 7,163.66  -> unpaid -419.55
//
// A payback needs to reduce that month's released WITHOUT the offsetting change to deducted,
// which is what actually clears the overpayment:
//
//   as a payback:    released 4,748.11 + deducted 2,000.00 = 6,748.11  -> unpaid   -4.00
//
// The target is stored as the payable rather than a bare month number because a payable
// already pins the employee, the month and the year together -- MONTH(period_from) is exactly
// what the report groups by, so there is no second way for the two to disagree.
//
// NULL for every existing row and for every expense on any other account, which is what keeps
// the existing deduction/refund behaviour untouched.
//
// Idempotent -- safe to re-run:
//   node src/db/add-commission-expense-month.js
const pool = require('../db');
require('dotenv').config();

const TABLE = 'commission_voucher_expenses';
const COLUMN = 'applies_to_payable_id';

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [[table]] = await pool.query('SHOW TABLES LIKE ?', [TABLE]);
  if (!table) {
    console.log(`${TABLE} does not exist here -- run create-commission-vouchers.js first.`);
    await pool.end();
    return;
  }

  const [cols] = await pool.query('SHOW COLUMNS FROM ??', [TABLE]);
  if (cols.some((c) => c.Field === COLUMN)) {
    console.log(`${COLUMN} already present.`);
  } else {
    // Appended rather than positioned: ADD COLUMN ... AFTER forces a full table rebuild,
    // where a plain append is instant. The same trap the users table hit on a live database.
    await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} BIGINT NULL`);
    console.log(`Added ${TABLE}.${COLUMN}.`);
  }

  const [[summary]] = await pool.query(
    `SELECT COUNT(*) AS expenses, SUM(${COLUMN} IS NOT NULL) AS targeted FROM ${TABLE}`,
  );
  console.log(`\n${TABLE}: ${summary.expenses} row(s), ${Number(summary.targeted || 0)} pointed at a month.`);

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
