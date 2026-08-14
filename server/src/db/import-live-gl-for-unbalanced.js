// Repairs the documents whose computed GL does not balance, by importing live's own posted
// entries for them into `live_gl_entries`.
//
// Vendor bills were the bulk of the trial balance's imbalance and got their own wholesale import
// (import-vendor-bill-gl.js) because 19,162 of 19,164 were broken. What is left is narrow by
// comparison -- 95 cheques of 14,640, 146 credit memos of 5,266, 6 journals of 5,805 -- so this
// takes the surgical route: compute the GL, find the documents that are one-sided, and fetch only
// those from live. A couple of hundred calls instead of twenty-five thousand.
//
// Documents that already balance are left entirely alone. Their computed GL was reverse-
// engineered from live in the first place and is self-consistent; re-importing it would churn
// account allocations for no gain.
//
// Sub-peso differences are ignored. A handful of documents are out by a centavo or two through
// rounding in live's own figures, and swapping a whole document's GL to chase 0.01 is not worth
// the inconsistency.
//
//   node src/db/import-live-gl-for-unbalanced.js --dry-run
//   node src/db/import-live-gl-for-unbalanced.js
//   node src/db/import-live-gl-for-unbalanced.js --type=cheque
const pool = require('../db');
const { getPostedGlLines } = require('../lib/glImpact');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const PAGE = 200;
const CONCURRENCY = 6;
const THRESHOLD = 1; // peso; below this it is rounding, not a broken entry

const argVal = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};

// source_type as getPostedGlLines labels it -> where to find the document, and what live calls it.
const TYPES = {
  cheque: { module: 'CHEQUE', table: 'cheques', noCol: 'cheque_no' },
  credit_memo: { module: 'CREDITMEMO', table: 'credit_memos', noCol: 'credit_memo_no' },
  journal: { module: 'JOURNAL', table: 'journals', noCol: 'journal_no' },
};
const WANTED = (argVal('type', Object.keys(TYPES).join(','))).split(',').map((s) => s.trim());

const norm = (s) => (s || '').toString().trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));
const numN = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const dateN = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? String(v).slice(0, 10) : null);

// Only the derived double-entry posting is the GL. Module_LdgrEntries = 'X' is the document's own
// user-typed line and importing it double-counts -- see import-vendor-bill-gl.js.
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
  }
  return rows;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- report only.' : 'APPLYING.');
  console.log(`Types: ${WANTED.join(', ')}\n`);

  // Which documents are actually broken, right now, with the current GL logic.
  const glLines = await getPostedGlLines({ toDate: '2099-12-31' });
  const byDoc = new Map();
  for (const l of glLines) {
    if (!WANTED.includes(l.source_type)) continue;
    const k = `${l.source_type}|${l.source_id}`;
    const e = byDoc.get(k) || { type: l.source_type, id: l.source_id, no: l.source_no, d: 0, c: 0 };
    e.d += Number(l.debit) || 0; e.c += Number(l.credit) || 0;
    byDoc.set(k, e);
  }
  const broken = [...byDoc.values()].filter((e) => Math.abs(e.d - e.c) >= THRESHOLD);
  const byType = {};
  for (const b of broken) byType[b.type] = (byType[b.type] || 0) + 1;
  console.log('unbalanced documents found:');
  for (const t of WANTED) console.log(`  ${t.padEnd(14)} ${byType[t] || 0}`);
  if (!broken.length) { console.log('\nNothing to do.'); await pool.end(); return; }

  const token = await login();

  const coa = await fetchAll(token, 'get_chart_of_accounts', null, 'chart of accounts');
  const [localCoa] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts');
  const byCode = new Map(localCoa.map((a) => [norm(a.account_code), a]));
  const byName = new Map(localCoa.map((a) => [norm(a.account_name), a]));
  const acctByLivePk = new Map();
  for (const a of coa) {
    const hit = byCode.get(norm(a.UserPK_COA)) || byName.get(norm(a.Title_COA));
    acctByLivePk.set(a.SysPK_COA, {
      id: hit?.id || null,
      code: hit?.account_code || a.UserPK_COA || null,
      name: hit?.account_name || a.Title_COA || null,
    });
  }
  console.log(`\nchart of accounts: live ${coa.length} | resolved locally ${[...acctByLivePk.values()].filter((x) => x.id).length}`);

  // Live document keys, per module, so a broken document can be looked up by its number.
  const livePkByType = {};
  for (const t of WANTED) {
    const cfg = TYPES[t];
    const docs = await fetchAll(token, 'get_transactions', { Module_TransH: cfg.module }, cfg.module);
    const m = new Map();
    for (const d of docs) if (d.UserPK_TransH) m.set(norm(d.UserPK_TransH), d.SysPK_TransH);
    livePkByType[t] = m;
    console.log(`live ${cfg.module}: ${docs.length}`);
  }

  const work = broken
    .map((b) => ({ ...b, live_pk: livePkByType[b.type]?.get(norm(b.no)) }))
    .filter((w) => w.live_pk);
  console.log(`\nbroken documents matched to live: ${work.length} of ${broken.length}\n`);

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
          where: { SysFK_TransH_LdgrEntries: w.live_pk }, limit: 200, offset: 0,
        }));
      } catch { failed += 1; continue; }
      fetched += 1;

      const rows = entries.map((e) => {
        const acct = acctByLivePk.get(e.SysFK_COA_LdgrEntries) || {};
        return [
          e.SysPK_LdgrEntries, w.live_pk, w.type, w.no, w.id,
          e.Module_LdgrEntries || null, acct.id || null, acct.code || null, acct.name || null,
          numN(e.DRAmount_LdgrEntries), numN(e.CRAmount_LdgrEntries), dateN(e.Date_LdgrEntries),
          null, null, e.Memo_LdgrEntries || null,
        ];
      }).filter((r) => r[0] && (r[9] || r[10]) && isGlPosting(r[5]));

      if (!rows.length) { noEntries += 1; continue; }

      // Adopt live's version when it is no worse than ours.
      //
      // Requiring it to balance outright was too strict. Live's own books are out on some of
      // these documents -- CHK-8876 debits 70,300.00 against a 140,600.00 bank credit in live's
      // GL, exactly as here -- so insisting on a balanced source left us mirroring nothing and
      // keeping our own, different wrongness. CHK-8404 was the clear case: live is out by
      // 59,000.00, we were out by 117,000.00, and refusing live's entries kept the worse figure.
      //
      // A clone should agree with the system it copies. Where live is unbalanced, matching it
      // keeps the discrepancy visible in both books instead of inventing a local variation.
      const d = rows.reduce((s, r) => s + r[9], 0);
      const c = rows.reduce((s, r) => s + r[10], 0);
      if (Math.abs(d - c) > Math.abs(w.d - w.c) + 0.005) { noEntries += 1; continue; }

      if (!DRY_RUN) {
        const ph = rows.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
        const [res] = await pool.query(
          `INSERT IGNORE INTO live_gl_entries
             (live_pk, live_trans_pk, source_type, source_no, source_id, entry_module,
              account_id, account_code, account_name, debit, credit, entry_date,
              location_id, department_id, memo)
           VALUES ${ph}`, rows.flat()
        );
        inserted += res.affectedRows;
      } else {
        inserted += rows.length;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`documents fetched ${fetched} | entries ${DRY_RUN ? 'would insert' : 'inserted'} ${inserted}`);
  console.log(`live had no usable balanced GL for: ${noEntries} | failed to fetch: ${failed}`);

  const [chk] = await pool.query(
    `SELECT source_type, COUNT(*) n, COUNT(DISTINCT source_id) docs, SUM(debit) d, SUM(credit) c
       FROM live_gl_entries GROUP BY source_type`
  );
  console.log('\nlive_gl_entries now holds:');
  for (const r of chk) {
    console.log(`  ${String(r.source_type).padEnd(14)} ${String(r.docs).padStart(6)} docs | ${String(r.n).padStart(6)} entries | imbalance ${(Number(r.d) - Number(r.c)).toFixed(2)}`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
