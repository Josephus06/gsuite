// Backfill sales_order_lines.tax_code_id from the SOURCE line's own tax code.
//
// import-sales.js used to stamp every SO line with the tax coded 'VAT12', which production does
// not have, so migrated lines landed with no tax code. Lines carrying 12% tax were filled from
// their own figures on 2026-10-01; the zero-tax ones cannot be, because three 0% taxes exist.
// This reads each remaining line's TaxCode_LdgrJob from the source and maps it with the table
// below (given by the user 2026-10-01).
//
// Matching: the importer numbered an order's lines 1..n over its NON-cancelled ledger lines, so
// local line_no N is the Nth non-cancelled source line. A line is only updated when that source
// line's description also matches; anything else is reported and left alone.
//
//   node src/db/backfill-so-line-tax-codes.js            dry run (default)
//   node src/db/backfill-so-line-tax-codes.js --apply
//
// Run it against ONE box of the droplet/office pair; replication carries it to the other.
require('dotenv').config();
const pool = require('../db');
const L = require('./lib/liveWindow');

const APPLY = process.argv.includes('--apply');
const SOURCE_TAX_MAP = {
  'VAT_PH:0-VAT': 'VATPH_0',
  'VAT_PH:EXEMPT': 'VATPH_EX',
  'VAT_PH:VATIN-12': 'VATPH_12',
  'VAT_PH:ZRATE': 'VATPH_ZRATE',
};
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN'}`);
  const [taxes] = await pool.query('SELECT id, code FROM taxes');
  const taxIdByCode = new Map(taxes.map((t) => [t.code, t.id]));

  const [missing] = await pool.query(`
    SELECT sol.id, sol.line_no, sol.description, so.sales_order_no, DATE(so.date_created) AS so_date
      FROM sales_order_lines sol
      JOIN sales_orders so ON so.id = sol.sales_order_id
      LEFT JOIN taxes t ON t.id = sol.tax_code_id
     WHERE t.id IS NULL
     ORDER BY so.date_created, so.id, sol.line_no`);
  console.log(`Lines with no tax code: ${missing.length}`);
  if (!missing.length) return;

  const bySo = new Map();
  for (const m of missing) {
    if (!bySo.has(m.sales_order_no)) bySo.set(m.sales_order_no, []);
    bySo.get(m.sales_order_no).push(m);
  }
  // Our date_created can sit days off the source's (SO-70930: 12 Aug here, 10 Aug there), so the
  // source window is widened by a month either side; orders are then found by number.
  const shift = (d, days) => { const x = new Date(`${L.day(d)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10); };
  const from = shift(missing[0].so_date, -31);
  const to = shift(missing[missing.length - 1].so_date, 31);
  console.log(`${bySo.size} Sales Orders, ${from} .. ${to}`);

  const token = await L.login();
  const soRows = await L.fetchWindow(token, {
    endpoint: 'get_sales_orders', from, to, keyField: 'so_upk', extra: { viewAll: true },
    onProgress: (msg) => console.log(msg),
  });
  const pkByNo = new Map(soRows.map((r) => [r.so_upk, r.so_pk]));

  const plan = [];          // { id, taxId }
  const tally = new Map();  // source code -> count
  const problems = { soNotInSource: 0, lineNotMatched: 0, codeUnmapped: new Map(), fetchFailed: 0 };
  let done = 0;
  for (const [soNo, lines] of bySo) {
    done += 1;
    if (done % 50 === 0) console.log(`  ...${done}/${bySo.size} orders`);
    const pk = pkByNo.get(soNo);
    if (!pk) { problems.soNotInSource += lines.length; continue; }
    let src;
    try {
      const est = await L.api(token, 'get_estimate', { pk });
      src = (est.data?.[1] || []).filter((l) => !l.IsCancelled_LdgrJob);
    } catch (e) {
      console.warn(`!! ${soNo}: ${e.message}`);
      problems.fetchFailed += lines.length;
      continue;
    }
    for (const line of lines) {
      const s = src[line.line_no - 1];
      if (!s || norm(s.Description_LdgrJob) !== norm(line.description)) { problems.lineNotMatched += 1; continue; }
      const code = String(s.TaxCode_LdgrJob || '').trim();
      const taxId = taxIdByCode.get(SOURCE_TAX_MAP[code] || code);
      if (!taxId) {
        problems.codeUnmapped.set(code || '(blank)', (problems.codeUnmapped.get(code || '(blank)') || 0) + 1);
        continue;
      }
      tally.set(code, (tally.get(code) || 0) + 1);
      plan.push({ id: line.id, taxId });
    }
  }

  console.log('\nWould set:');
  for (const [code, n] of tally) console.log(`  ${code} -> ${SOURCE_TAX_MAP[code] || code}: ${n} lines`);
  console.log('Left alone:');
  console.log(`  SO not found in source: ${problems.soNotInSource}`);
  console.log(`  source fetch failed:    ${problems.fetchFailed}`);
  console.log(`  line not matched:       ${problems.lineNotMatched}`);
  for (const [code, n] of problems.codeUnmapped) console.log(`  unmapped code ${code}: ${n}`);

  if (!APPLY) { console.log('\nDRY RUN -- nothing written. Re-run with --apply.'); return; }
  let changed = 0;
  for (const p of plan) {
    // Re-checks the code is still missing, so a re-run or a concurrent edit is never overwritten.
    const [r] = await pool.query(
      `UPDATE sales_order_lines sol LEFT JOIN taxes t ON t.id = sol.tax_code_id
          SET sol.tax_code_id = ? WHERE sol.id = ? AND t.id IS NULL`, [p.taxId, p.id]);
    changed += r.affectedRows;
  }
  console.log(`\nUpdated ${changed} of ${plan.length} planned lines.`);
}

main()
  .catch((e) => { console.error('ERR', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
