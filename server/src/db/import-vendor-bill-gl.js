// Imports live's posted GL lines for vendor bills into `live_gl_entries`.
//
// See add-live-gl-entries.js for why these are imported rather than re-derived: the expense
// account lives on live's GL line, not the bill header, and 31 of 40 sampled bills debit more
// than one account, so no header field could reproduce them.
//
// HOW IT PAGES. Live offers no bulk route to these rows. ModuleTrans_LdgrEntries is null on every
// entry, so they cannot be filtered by document type, and get_transaction_ledger_entries ignores
// an array of transaction keys -- both were tried. That leaves one call per bill, which is why
// this runs several at a time and prints progress.
//
// A bill whose entries fail to fetch is retried by api() and then left alone -- it simply keeps
// whatever the computed GL produced. Nothing is deleted and nothing is overwritten: INSERT IGNORE
// on live_pk means a second run only adds what the first one missed.
//
//   node src/db/import-vendor-bill-gl.js --dry-run
//   node src/db/import-vendor-bill-gl.js
//   node src/db/import-vendor-bill-gl.js --limit=200        (a small slice, for checking)
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const PAGE = 200;
const CONCURRENCY = 6;

const argVal = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};
const LIMIT = Number(argVal('limit', 0)) || 0;

const norm = (s) => (s || '').toString().trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));
const numN = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const dateN = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? String(v).slice(0, 10) : null);

// Live puts two different things in the same table. Module_LdgrEntries = 'X' is the document's
// own user-typed line -- the thing you see on the Vendor Bill form -- while the '*GENENTRY'
// variants (GENENTRY, AP-GENENTRY) are the derived double-entry posting. Only the latter is the
// GL. Importing 'X' as well double-counts the debit side: VB-5 came in at Dr 13,875.00 against
// Cr 6,937.50, exactly its own line counted twice.
const isGlPosting = (mod) => /GENENTRY$/i.test(String(mod || ''));

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  const b = await r.json();
  if (!b?.data?.token) throw new Error(`Login failed: ${b?.message || 'no token'}`);
  return b.data.token;
}

async function api(token, ep, payload, attempts = 4) {
  let last;
  for (let a = 0; a < attempts; a += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000 + a * 15000);
    try {
      const r = await fetch(`${SITE}/api/${ep}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload), signal: ctl.signal,
      });
      const j = await r.json(); clearTimeout(timer); return j;
    } catch (e) { clearTimeout(timer); last = e; await sleep(1000 * (a + 1)); }
  }
  throw last;
}

// Two consecutive empty pages end a list; one short page does not.
async function fetchAll(token, ep, where, label) {
  const rows = [];
  let emptyStreak = 0;
  for (let off = 0; off < 200000; off += PAGE) {
    let batch = [];
    try { batch = listRows(await api(token, ep, { ...(where ? { where } : {}), limit: PAGE, offset: off })); }
    catch (e) { console.warn(`  !! ${label} page ${off} failed: ${e.message}`); }
    if (!batch.length) {
      emptyStreak += 1;
      if (emptyStreak >= 2) break;
      continue;
    }
    emptyStreak = 0;
    rows.push(...batch);
    if (rows.length % 2000 === 0) console.log(`  ...${label} ${rows.length}`);
  }
  return rows;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- report only.\n' : 'APPLYING.\n');

  const token = await login();

  // Live chart of accounts -> local account ids, matched on the account code.
  const coa = await fetchAll(token, 'get_chart_of_accounts', null, 'chart of accounts');
  const [localCoa] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts');
  const byCode = new Map(localCoa.map((a) => [norm(a.account_code), a]));
  const byName = new Map(localCoa.map((a) => [norm(a.account_name), a]));
  const acctByLivePk = new Map();
  for (const a of coa) {
    const hit = byCode.get(norm(a.UserPK_COA)) || byName.get(norm(a.Title_COA));
    // Keep the live code/title even when nothing local matches, so an unresolved account still
    // shows up in the ledger rather than disappearing from the totals.
    acctByLivePk.set(a.SysPK_COA, {
      id: hit?.id || null,
      code: hit?.account_code || a.UserPK_COA || null,
      name: hit?.account_name || a.Title_COA || null,
    });
  }
  console.log(`chart of accounts: live ${coa.length} | resolved locally ${[...acctByLivePk.values()].filter((x) => x.id).length}\n`);

  // Live vendor bills, keyed by bill number -- which is how they match ours.
  const bills = await fetchAll(token, 'get_transactions', { Module_TransH: 'VENDORBILL' }, 'vendor bills');
  const livePkByNo = new Map();
  for (const b of bills) if (b.UserPK_TransH) livePkByNo.set(norm(b.UserPK_TransH), b.SysPK_TransH);
  console.log(`\nlive vendor bills: ${bills.length}`);

  const [locals] = await pool.query("SELECT id, bill_no FROM vendor_bills WHERE status <> 'cancelled'");
  let work = locals
    .map((l) => ({ id: l.id, bill_no: l.bill_no, live_pk: livePkByNo.get(norm(l.bill_no)) }))
    .filter((w) => w.live_pk);
  console.log(`local vendor bills: ${locals.length} | matched to live: ${work.length}`);

  // Skip bills already imported, so a re-run resumes instead of re-fetching everything.
  const [done] = await pool.query("SELECT DISTINCT source_id FROM live_gl_entries WHERE source_type = 'vendor_bill'");
  const doneSet = new Set(done.map((d) => d.source_id));
  work = work.filter((w) => !doneSet.has(w.id));
  if (LIMIT) work = work.slice(0, LIMIT);
  console.log(`already imported: ${doneSet.size} | to fetch now: ${work.length}\n`);

  let fetched = 0; let inserted = 0; let failed = 0; let noEntries = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor; cursor += 1;
      if (i >= work.length) return;
      const w = work[i];
      let entries = [];
      try {
        entries = listRows(await api(token, 'get_transaction_ledger_entries', {
          where: { SysFK_TransH_LdgrEntries: w.live_pk }, limit: 100, offset: 0,
        }));
      } catch {
        failed += 1;
        continue;
      }
      fetched += 1;
      if (!entries.length) { noEntries += 1; continue; }

      if (!DRY_RUN) {
        const rows = entries.map((e) => {
          const acct = acctByLivePk.get(e.SysFK_COA_LdgrEntries) || {};
          return [
            e.SysPK_LdgrEntries, w.live_pk, 'vendor_bill', w.bill_no, w.id,
            e.Module_LdgrEntries || null, acct.id || null, acct.code || null, acct.name || null,
            numN(e.DRAmount_LdgrEntries), numN(e.CRAmount_LdgrEntries), dateN(e.Date_LdgrEntries),
            null, null, e.Memo_LdgrEntries || null,
          ];
        }).filter((r) => r[0] && (r[9] || r[10]) && isGlPosting(r[5]));
        if (rows.length) {
          const ph = rows.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
          const [res] = await pool.query(
            `INSERT IGNORE INTO live_gl_entries
               (live_pk, live_trans_pk, source_type, source_no, source_id, entry_module,
                account_id, account_code, account_name, debit, credit, entry_date,
                location_id, department_id, memo)
             VALUES ${ph}`, rows.flat()
          );
          inserted += res.affectedRows; // rows accepted, not rows sent
        }
      }
      if (fetched % 500 === 0) {
        console.log(`  ${fetched}/${work.length} bills | ${inserted} entries | ${failed} failed`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nbills fetched ${fetched} | entries ${DRY_RUN ? 'would insert' : 'inserted'} ${inserted}`);
  console.log(`bills live had no GL for: ${noEntries} | bills that failed to fetch: ${failed}`);

  const [[chk]] = await pool.query(
    `SELECT COUNT(*) n, COUNT(DISTINCT source_id) bills, SUM(debit) d, SUM(credit) c
       FROM live_gl_entries WHERE source_type = 'vendor_bill'`
  );
  console.log(`\nlive_gl_entries now: ${chk.n} entries over ${chk.bills} bills`);
  console.log(`  debit  ${Number(chk.d || 0).toLocaleString()}`);
  console.log(`  credit ${Number(chk.c || 0).toLocaleString()}`);
  console.log(`  imbalance ${(Number(chk.d || 0) - Number(chk.c || 0)).toFixed(2)}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
