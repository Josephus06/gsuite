// Lets a bank-only statement line post the journal it always implied.
//
// A statement line the book has never heard of -- a bank charge, interest credited, an inward
// credit with no advice -- could be tagged "bank only" against an account, and that cleared the
// needs-review gate. It posted nothing, so the book balance never moved and the reconciliation
// stayed out of balance by exactly that amount. Measured on a live workspace: an 800 credit marked
// bank-only left `difference 800.00, balanced=false`, and Reconcile refused with "This does not
// balance yet". The button could never finish the job it appeared to do.
//
// So marking a line now writes a journal on the bank account against the account named, and
// matches the line to it. posted_journal_id is what ties the two together -- it is how undoing the
// mark knows which journal to void, and it is the only thing standing between a corrected
// reconciliation and a duplicate entry in the general ledger.
//
// NOT A FOREIGN KEY, matching how this schema treats every other cross-document link
// (sales_invoices.estimate_id, sales_order_lines.estimate_job_order_id): these tables carry no FK
// constraints, and adding one here alone would make this the only place a journal cannot be
// deleted.
//
// NOTHING IS BACKFILLED. Existing bank_only lines posted no journal and get NULL, which is exactly
// what they are. Their reconciliations are still out of balance by their amount and still cannot
// be finished -- reopening one and re-marking the line is what posts the entry.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-bank-only-journal.js
require('dotenv').config();
const pool = require('../db');

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}
async function indexExists(table, index) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, [table, index],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  if (await columnExists('bank_statement_lines', 'posted_journal_id')) {
    console.log('  bank_statement_lines.posted_journal_id already exists -- skipped.');
  } else {
    await pool.query('ALTER TABLE bank_statement_lines ADD COLUMN posted_journal_id BIGINT NULL AFTER bank_only_account_id');
    console.log('  bank_statement_lines.posted_journal_id added.');
  }

  if (await indexExists('bank_statement_lines', 'idx_bank_statement_lines_journal')) {
    console.log('  idx_bank_statement_lines_journal already exists -- skipped.');
  } else {
    await pool.query('CREATE INDEX idx_bank_statement_lines_journal ON bank_statement_lines (posted_journal_id)');
    console.log('  idx_bank_statement_lines_journal created.');
  }

  const [[s]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(status = 'bank_only') AS bank_only,
            SUM(status = 'bank_only' AND posted_journal_id IS NULL) AS bank_only_unposted
       FROM bank_statement_lines`,
  );
  console.log(`\n  ${s.total} statement line(s): ${s.bank_only || 0} marked bank-only, `
    + `${s.bank_only_unposted || 0} of those with no journal behind them.`);
  if (Number(s.bank_only_unposted) > 0) {
    console.log('  Those predate this change. Re-marking each one posts its entry; until then their');
    console.log('  reconciliation cannot balance, which was true before this migration too.');
  }

  await pool.end();
}

main().catch(async (err) => { console.error('Failed:', err.message); await pool.end(); process.exit(1); });
