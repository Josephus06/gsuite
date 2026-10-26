// Migrated journals the source never posted, flagged so the reports count them (2026-10-26).
//
// JRNL-6087 (1st-half September payroll, PHP 1,056,757.88) came over from the source with the rest
// of its journals, but the source's ledger has no entry for it -- not on 30601, 30605, 30606, 30517,
// 30518 or any of its accounts. The source's September figures (opening_gl_balances), which ARE
// September in T1S's reports (lib/openingBalances.js), therefore have no payroll for that half:
// HDMF / PHIC Employer Share showed 0 for the month. A journal keyed in T1S for the source period
// already counts on top of those figures (lib/glImpact.js preStartT1sJournalLines); a migrated one
// never did, since the source's figures were assumed to contain it. This marks the ones they do not
// contain with journals.adds_to_source_figures = 1, which that same rule now honours.
//
// HOW A JOURNAL IS JUDGED UNPOSTED: for EVERY account on its lines, the source's ledger for that
// account over the journal's month (lib/sourceLedger accountLedger, every location) does not list
// the journal's number. One account listing it and the journal is left alone.
//
// Flags only; posts nothing, edits no line. Undo with UPDATE journals SET adds_to_source_figures = 0.
//
//   node src/db/flag-unposted-source-journals.js --from=2026-09-01 --to=2026-09-30          # dry run
//   node src/db/flag-unposted-source-journals.js --only=JRNL-6087 --apply
require('dotenv').config();
const pool = require('../db');
const { accountLedger } = require('../lib/sourceLedger');
const { booksStart } = require('../lib/openingBalances');

const APPLY = process.argv.includes('--apply');
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || null;
const ONLY = arg('only') ? arg('only').split(',') : null;

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
  return r.n > 0;
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- DRY RUN'}\n`);
  if (!await columnExists('journals', 'adds_to_source_figures')) {
    if (APPLY) {
      await pool.query('ALTER TABLE journals ADD COLUMN adds_to_source_figures TINYINT(1) NOT NULL DEFAULT 0');
      console.log('  journals.adds_to_source_figures added, defaulting to 0.\n');
    } else console.log('  Would add journals.adds_to_source_figures (TINYINT, default 0).\n');
  }
  const books = await booksStart();
  if (!books) { console.log('No source figures loaded -- nothing to do.'); process.exit(0); }
  const from = arg('from') || books.first; const to = arg('to') || books.asOf;

  // Migrated (no 'Created' audit row), not a document's reversal, dated in the source period.
  const [js] = await pool.query(
    `SELECT j.id, j.journal_no, DATE_FORMAT(j.date_created, '%Y-%m-%d') AS d, j.total_debit
       FROM journals j
      WHERE j.status <> 'void' AND j.source_type IS NULL AND j.date_created > ? AND j.date_created <= ?
        AND j.date_created >= ? AND j.date_created <= ?${ONLY ? ' AND j.journal_no IN (?)' : ''}
        AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.auditable_type = 'Journal' AND a.auditable_id = j.id AND a.event_type = 'Created')
      ORDER BY j.date_created, j.journal_no`,
    [books.first, books.asOf, from, to, ...(ONLY ? [ONLY] : [])]);
  console.log(`${js.length} migrated journal(s) dated ${from}..${to} to check against the source's ledger.\n`);

  const ledgers = new Map(); // "code|YYYY-MM" -> Set of document numbers
  const unposted = [];
  for (const j of js) {
    const [accts] = await pool.query(
      `SELECT DISTINCT coa.account_code FROM journal_lines jl JOIN chart_of_accounts coa ON coa.id = jl.account_id
        WHERE jl.journal_id = ? AND (jl.debit <> 0 OR jl.credit <> 0)`, [j.id]);
    if (!accts.length) continue;
    const month = j.d.slice(0, 7);
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    let found = false;
    for (const { account_code: code } of accts) {
      const k = `${code}|${month}`;
      if (!ledgers.has(k)) {
        const docs = await accountLedger({ accountCode: code, side: 'DEBIT', from: `${month}-01`, to: `${month}-${last}` });
        ledgers.set(k, new Set(docs.map((t) => String(t.document))));
      }
      if (ledgers.get(k).has(j.journal_no)) { found = true; break; }
    }
    if (!found) {
      unposted.push(j);
      console.log(`  ${j.journal_no}  ${j.d}  ${Number(j.total_debit).toFixed(2).padStart(14)}  not in the source's ledger on any of its ${accts.length} account(s)`);
    }
  }
  console.log(`\n${unposted.length} of ${js.length} not posted in the source.`);

  if (APPLY && unposted.length) {
    const [r] = await pool.query('UPDATE journals SET adds_to_source_figures = 1 WHERE id IN (?) AND adds_to_source_figures = 0', [unposted.map((j) => j.id)]);
    console.log(`Flagged ${r.affectedRows} journal(s); the reports now count them on top of the source's figures.`);
  } else if (unposted.length) console.log('Dry run -- re-run with --apply to flag them.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
