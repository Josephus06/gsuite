// Adds `date_released` to bill_payments, which the source system has and this build did not.
//
// The live Bill Payment screen carries a "Date Released" field, edited separately from Date
// Created -- a payment is raised on one day and the cheque or cash actually handed over on
// another, and the Disbursement Report is asked for by the day the money LEFT. cheques has held
// this column since it was created; bill_payments never got one, so the two halves of a
// disbursement could not be reported on the same basis.
//
// IT IS LEFT NULL ON EXISTING ROWS, deliberately. The live list endpoint (get_bill_payments)
// does not expose a released date at all -- it returns DateCreated, DateDue and CheckDate and
// nothing else -- and the live record this was checked against (BPAY-13706) shows the field
// blank, so there is nothing to import and no honest way to infer it. Filling it from CheckDate
// would manufacture a release date for 867 payments that may never have been released on that
// day. A payment with no date released is simply not yet released, and the report says how many
// are in that state rather than quietly counting them.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-bill-payment-date-released.js
const pool = require('../db');

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  if (await columnExists('bill_payments', 'date_released')) {
    console.log('  bill_payments.date_released already exists -- skipped.');
  } else {
    await pool.query('ALTER TABLE bill_payments ADD COLUMN date_released DATE NULL AFTER check_no');
    console.log('  bill_payments.date_released added.');
  }

  const [[s]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(date_released IS NOT NULL) AS released,
            SUM(status <> 'voided') AS live
       FROM bill_payments`,
  );
  console.log(`\n${s.total} bill payments (${Number(s.live) || 0} not voided), `
    + `${Number(s.released) || 0} with a Date Released.`);
  console.log('Set it on the Bill Payment screen; until then a payment does not appear in the');
  console.log('Disbursement Report, which is keyed on the day the money actually went out.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
