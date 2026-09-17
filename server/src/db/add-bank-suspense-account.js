// A suspense account for bank items nobody can identify yet.
//
// WHY THIS IS IN THE CHART OF ACCOUNTS, having been asked for outside it.
//
// The ask was an account that takes these postings without appearing in the financial statements.
// The half of that which matters -- keep unidentified money out of real revenue and expense --
// is exactly right, and it is what this delivers. The other half cannot be done: every posting
// here is one half of a double entry. When a bank-only line debits the bank 47,309.32, something
// must credit 47,309.32. If that something is outside the chart, the trial balance is out by the
// suspense balance and the balance sheet does not balance -- permanently, and by exactly the
// amount nobody has explained. That is a broken ledger, not a hidden one.
//
// LIABILITY / OTHER CURRENT LIABILITIES gets the real requirement:
//
//   Income Statement   groups INCOME and EXPENSE only, so this NEVER appears. Revenue and
//                      expenses are undistorted, which is the thing that was going wrong --
//                      a 47,309.32 deposit credited to 30701 Bank Charges made that expense
//                      read 47k cheaper than it was.
//   Balance Sheet      groups ASSET, LIABILITY and EQUITY, so it DOES appear, and should.
//                      Money received and not yet explained is money that might have to go
//                      back; showing it as a current liability is both correct and the thing
//                      that makes somebody clear it.
//
// A liability rather than an asset because unidentified RECEIPTS are the common case here and
// they are, until explained, somebody else's money. Unidentified payments post the other way and
// leave it in debit, which is normal for a clearing account and reads as "the bank took money we
// cannot account for" -- itself worth seeing.
//
// THE BALANCE IS THE POINT. A suspense account with a growing balance is the signal that
// documents are not reaching accounting. One at zero means everything found its home.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-bank-suspense-account.js
require('dotenv').config();
const pool = require('../db');

const CODE = '23100';
const NAME = 'Bank Suspense - Unidentified Items';

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  const [[existing]] = await pool.query(
    'SELECT id, account_name FROM chart_of_accounts WHERE account_code = ?', [CODE]);
  if (existing) {
    console.log(`  ${CODE} already exists as "${existing.account_name}" -- skipped.`);
  } else {
    const [[type]] = await pool.query(
      "SELECT id FROM chart_of_account_types WHERE account_type = 'LIABILITY' AND account_sub_type = 'OTHER CURRENT LIABILITIES'");
    if (!type) throw new Error('The OTHER CURRENT LIABILITIES account type is missing from chart_of_account_types.');

    // Sits beside 23000 Customer Deposits, which is the nearest thing to it: money held that is
    // not yet income.
    await pool.query(
      `INSERT INTO chart_of_accounts
         (account_code, account_name, account_type, detail_type, coa_type_id, is_summary, is_active, description, created_at)
       VALUES (?, ?, 'Liability', 'Other Current Liability', ?, 0, 1, ?, NOW())`,
      [CODE, NAME, type.id,
        'Bank statement items with no document yet -- unidentified credits and debits parked here '
        + 'by Bank Reconciliation. Clear each one to its real account when the paperwork arrives; '
        + 'a growing balance means documents are not reaching accounting.'],
    );
    console.log(`  ${CODE} ${NAME} created as LIABILITY / OTHER CURRENT LIABILITIES.`);
  }

  const [[acct]] = await pool.query('SELECT id FROM chart_of_accounts WHERE account_code = ?', [CODE]);
  const [[bal]] = await pool.query(
    `SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS balance, COUNT(*) AS entries
       FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
      WHERE jl.account_id = ? AND j.voided_at IS NULL`, [acct.id]);
  console.log(`\n  ${bal.entries} entr(ies), balance ${Number(bal.balance).toLocaleString('en-US', { minimumFractionDigits: 2 })} (credit positive).`);
  console.log('  It is on the Balance Sheet and never on the Income Statement -- see the note at the');
  console.log('  top of this file for why it has to be one of those two rather than neither.');

  await pool.end();
}

main().catch(async (err) => { console.error('Failed:', err.message); await pool.end(); process.exit(1); });
