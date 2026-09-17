// The two accounts bank-only items are parked in: Deposit for money in, Disbursement for money out.
//
// Supersedes the single "Bank Suspense - Unidentified Items" added in 77ef56e, which had not been
// posted to. One account would have netted receipts against payments and shown a single figure
// that is the difference between two unrelated problems; two say how much came in that nobody can
// explain and how much went out, which are different questions asked of different people.
//
//   23100  Deposit        money the bank credited with no document yet -- an inward credit, a
//                         collection with no advice. LIABILITY: until it is identified it may
//                         have to go back, so it is somebody else's money.
//   23200  Disbursement   money the bank took with no document yet -- a debit memo, a charge,
//                         an unexplained withdrawal. ASSET: it is owed to us or owed an
//                         explanation until somebody produces the paperwork.
//
// Both carry exclude_from_reports, so neither appears in the Trial Balance, Balance Sheet, Income
// Statement or General Ledger. That was asked for directly, and the cost is stated in
// add-account-exclude-from-reports.js: the statements no longer foot by whatever is parked here.
//
// The codes sit together at 23100/23200 so they read as a pair in the account picker, which is how
// they will be used. That puts an asset inside the 2xxxx liability block -- untidy against the
// chart's convention, and the lesser of the two evils: separating them by 10,000 would scatter a
// matched pair across a dropdown nobody wants to hunt through.
//
// IDEMPOTENT: safe to re-run. Renames 23100 only while it still carries the old suspense name and
// has never been posted to, so a re-run cannot rename an account somebody has since repurposed.
//
//   node src/db/add-deposit-disbursement-accounts.js
require('dotenv').config();
const pool = require('../db');

const OLD_NAME = 'Bank Suspense - Unidentified Items';
const PAIR = [
  {
    code: '23100',
    name: 'Deposit',
    accountType: 'Liability',
    detailType: 'Other Current Liability',
    subType: 'OTHER CURRENT LIABILITIES',
    description: 'Bank statement CREDITS with no document yet, parked by Bank Reconciliation. '
      + 'Clear each one to its real account when the paperwork arrives. Excluded from all accounting reports.',
  },
  {
    code: '23200',
    name: 'Disbursement',
    accountType: 'Asset',
    detailType: 'Other Current Asset',
    subType: 'OTHER CURRENT ASSETS',
    description: 'Bank statement DEBITS with no document yet, parked by Bank Reconciliation. '
      + 'Clear each one to its real account when the paperwork arrives. Excluded from all accounting reports.',
  },
];

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  const [[hasFlag]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'chart_of_accounts' AND column_name = 'exclude_from_reports'`);
  if (!hasFlag.n) throw new Error('Run src/db/add-account-exclude-from-reports.js first.');

  for (const a of PAIR) {
    const [[type]] = await pool.query(
      'SELECT id FROM chart_of_account_types WHERE account_sub_type = ?', [a.subType]);
    if (!type) throw new Error(`Missing account type ${a.subType}.`);

    const [[existing]] = await pool.query(
      'SELECT id, account_name FROM chart_of_accounts WHERE account_code = ?', [a.code]);

    if (!existing) {
      await pool.query(
        `INSERT INTO chart_of_accounts
           (account_code, account_name, account_type, detail_type, coa_type_id, is_summary, is_active,
            exclude_from_reports, description, created_at)
         VALUES (?, ?, ?, ?, ?, 0, 1, 1, ?, NOW())`,
        [a.code, a.name, a.accountType, a.detailType, type.id, a.description]);
      console.log(`  ${a.code} ${a.name} created (${a.accountType}), excluded from reports.`);
      continue;
    }

    if (existing.account_name === a.name) {
      await pool.query('UPDATE chart_of_accounts SET exclude_from_reports = 1 WHERE id = ?', [existing.id]);
      console.log(`  ${a.code} ${a.name} already exists -- left alone, exclusion confirmed.`);
      continue;
    }

    // Only ever renames the account this script itself created, and only while nothing has been
    // posted to it. Anything else is somebody's real account and is reported rather than touched.
    const [[used]] = await pool.query('SELECT COUNT(*) AS n FROM journal_lines WHERE account_id = ?', [existing.id]);
    if (existing.account_name === OLD_NAME && Number(used.n) === 0) {
      await pool.query(
        `UPDATE chart_of_accounts
            SET account_name = ?, account_type = ?, detail_type = ?, coa_type_id = ?,
                exclude_from_reports = 1, description = ?
          WHERE id = ?`,
        [a.name, a.accountType, a.detailType, type.id, a.description, existing.id]);
      console.log(`  ${a.code} renamed "${OLD_NAME}" -> "${a.name}" (${a.accountType}), never posted to.`);
    } else {
      console.log(`  ${a.code} is "${existing.account_name}" with ${used.n} posting(s) -- LEFT ALONE.`);
      console.log('     Point the pair at free codes instead; this script will not touch a real account.');
    }
  }

  const [rows] = await pool.query(
    `SELECT c.account_code, c.account_name, c.account_type, c.exclude_from_reports,
            (SELECT COALESCE(SUM(jl.credit - jl.debit), 0) FROM journal_lines jl
               JOIN journals j ON j.id = jl.journal_id
              WHERE jl.account_id = c.id AND j.voided_at IS NULL) AS balance
       FROM chart_of_accounts c WHERE c.exclude_from_reports = 1 ORDER BY c.account_code`);
  console.log(`\n  ${rows.length} account(s) excluded from every accounting report:`);
  rows.forEach((x) => console.log(`    ${x.account_code}  ${String(x.account_name).padEnd(14)} ${String(x.account_type).padEnd(10)} balance ${Number(x.balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}`));

  await pool.end();
}

main().catch(async (err) => { console.error('Failed:', err.message); await pool.end(); process.exit(1); });
