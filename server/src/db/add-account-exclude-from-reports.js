// Lets an account be kept out of every accounting report, and marks the bank suspense account
// as one.
//
// WHAT THIS DOES TO THE REPORTS, stated plainly because it is not a small thing.
//
// The journals stay balanced -- every entry still has equal debits and credits, and nothing here
// touches how they are written. What changes is the REPORTS. The Balance Sheet will no longer
// foot: the bank movement is in Assets and the offsetting credit is excluded, so Assets will
// differ from Liabilities + Equity by whatever is parked in suspense. The Trial Balance will not
// tie for the same reason. That is the consequence of the instruction, and it was given knowingly.
//
// A COLUMN RATHER THAN NULLING coa_type_id. Blanking the account's type would also hide it -- the
// report grouper skips anything with no type -- but it would look like missing data to the next
// person, and be "fixed" by somebody tidying the chart, silently putting the account back into
// the statements. A flag named exclude_from_reports says what it is and why, and can be turned
// off again with an UPDATE.
//
// APPLIED IN loadCoa(), which is the one door every report goes through: Trial Balance, Balance
// Sheet, Income Statement, General Ledger and the GL transaction drill-down all read from it. The
// alternative -- filtering in each report -- would leave the next report anyone adds including it
// again by default.
//
// WHERE THE MONEY IS STILL VISIBLE, since an account no report shows is one nobody can clear:
// Bank Reconciliation shows which lines posted to it ("Posted JRNL-#### to Bank Suspense"), and
// the journals themselves are in the Journals module. Nothing in reporting will total it.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-account-exclude-from-reports.js
require('dotenv').config();
const pool = require('../db');

const SUSPENSE = '23100';

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  if (await columnExists('chart_of_accounts', 'exclude_from_reports')) {
    console.log('  chart_of_accounts.exclude_from_reports already exists -- skipped.');
  } else {
    await pool.query(
      'ALTER TABLE chart_of_accounts ADD COLUMN exclude_from_reports TINYINT(1) NOT NULL DEFAULT 0');
    console.log('  chart_of_accounts.exclude_from_reports added, defaulting to 0.');
  }

  const [r] = await pool.query(
    'UPDATE chart_of_accounts SET exclude_from_reports = 1 WHERE account_code = ? AND exclude_from_reports = 0',
    [SUSPENSE]);
  console.log(r.affectedRows
    ? `  ${SUSPENSE} marked excluded from accounting reports.`
    : `  ${SUSPENSE} was already marked excluded.`);

  const [excluded] = await pool.query(
    'SELECT account_code, account_name FROM chart_of_accounts WHERE exclude_from_reports = 1 ORDER BY account_code');
  console.log(`\n  ${excluded.length} account(s) excluded from every accounting report:`);
  excluded.forEach((a) => console.log(`    ${a.account_code}  ${a.account_name}`));

  const [[acct]] = await pool.query('SELECT id FROM chart_of_accounts WHERE account_code = ?', [SUSPENSE]);
  const [[bal]] = await pool.query(
    `SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS balance FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id
      WHERE jl.account_id = ? AND j.voided_at IS NULL`, [acct.id]);
  const parked = Number(bal.balance);
  console.log(`\n  Parked in suspense right now: ${parked.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log('  The Balance Sheet and Trial Balance will be out by this figure, by design.');

  await pool.end();
}

main().catch(async (err) => { console.error('Failed:', err.message); await pool.end(); process.exit(1); });
