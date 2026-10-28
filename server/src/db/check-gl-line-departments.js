// Journal and Check Voucher lines with NO department (2026-10-28) -- the "no department" amounts on the
// Income Statement. Report only.
//
// Per year: how many non-void lines have no department, split into Income Statement accounts
// (Revenue / Expense -- these are what show without a department) and Balance Sheet accounts, with
// the Income Statement amount. Then the documents carrying the most of it in --year (default: this year).
// Run backfill-journal-line-departments.js / backfill-cheque-line-departments.js first: what is left
// here after them had no department in the source either, or was keyed in T1S before departments
// became required on every line (2026-10-07).
//
//   node src/db/check-gl-line-departments.js [--year=2026] [--top=30]
require('dotenv').config();
const pool = require('../db');

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const YEAR = Number(arg('year', new Date().getFullYear()));
const TOP = Number(arg('top', 30));
const peso = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const SOURCES = [
  {
    label: 'JOURNALS', lines: `SELECT jl.id, jl.account_id, jl.department_id, (jl.debit - jl.credit) AS amount,
                                    j.id AS doc_id, j.journal_no AS doc_no, j.date_created, j.memo, j.form_request_id
                               FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
                              WHERE COALESCE(j.status, '') <> 'void'`,
  },
  {
    label: 'CHECKS', lines: `SELECT cl.id, cl.account_id, cl.department_id, cl.amount,
                                  c.id AS doc_id, c.cheque_no AS doc_no, c.date_created, c.payee_name AS memo, c.form_request_id
                             FROM cheque_lines cl JOIN cheques c ON c.id = cl.cheque_id
                            WHERE COALESCE(c.status, '') NOT IN ('void', 'voided', 'cancelled')`,
  },
];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const s of SOURCES) {
    const [byYear] = await pool.query(
      `SELECT YEAR(x.date_created) AS yr, COUNT(*) AS n, SUM(x.department_id IS NULL) AS blank,
              SUM(x.department_id IS NULL AND coa.account_type IN ('Revenue', 'Expense')) AS blank_is,
              SUM(CASE WHEN x.department_id IS NULL AND coa.account_type IN ('Revenue', 'Expense') THEN x.amount ELSE 0 END) AS blank_is_amt
         FROM (${s.lines}) x LEFT JOIN chart_of_accounts coa ON coa.id = x.account_id
        GROUP BY yr ORDER BY yr`);
    console.log(`\n== ${s.label}: lines with no department, by year`);
    console.log('  year     lines    blank   blank on IS accts   IS amount');
    for (const r of byYear) {
      console.log(`  ${r.yr}  ${String(r.n).padStart(8)} ${String(r.blank).padStart(8)} ${String(r.blank_is).padStart(19)}   ${peso(r.blank_is_amt).padStart(16)}`);
    }

    const [docs] = await pool.query(
      `SELECT x.doc_no, x.date_created, LEFT(x.memo, 60) AS memo, fr.request_no, COUNT(*) AS n, SUM(x.amount) AS amt
         FROM (${s.lines}) x JOIN chart_of_accounts coa ON coa.id = x.account_id
         LEFT JOIN form_requests fr ON fr.id = x.form_request_id
        WHERE x.department_id IS NULL AND coa.account_type IN ('Revenue', 'Expense') AND YEAR(x.date_created) = ?
        GROUP BY x.doc_id ORDER BY ABS(SUM(x.amount)) DESC LIMIT ?`, [YEAR, TOP]);
    if (!docs.length) { console.log(`  ${YEAR}: none on Income Statement accounts.`); continue; }
    console.log(`  ${YEAR}, most Income Statement amount with no department:`);
    for (const d of docs) {
      console.log(`    ${d.doc_no.padEnd(12)} ${String(d.date_created instanceof Date ? d.date_created.toISOString() : d.date_created).slice(0, 10)}  ${String(d.n).padStart(3)} line(s) ${peso(d.amt).padStart(15)}  ${d.request_no ? `[${d.request_no}] ` : ''}${d.memo || ''}`);
    }
  }
  await pool.end();
})().catch(async (e) => { console.error('ERR', e.message); await pool.end(); process.exit(1); });
