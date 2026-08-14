// Migrates live's Fund Transfers (Accounting > Fund Transfers, FT-###) into `fund_transfers`.
//
// The module already existed here -- routes, list, view, GL impact -- against an empty table.
// Live holds 931 under Module_TransH='FUNDTRANSFER', numbered FT-### exactly as this app does.
//
// WHERE THE TWO ACCOUNTS COME FROM. A transfer needs a From and a To, but live's header carries
// only one account, SysFK_COA_TransH. Its GL settles the question: the transfer posts DR the
// destination / CR the source, and the header account is always the credited one. Verified across
// twelve transfers before writing -- header matched the credit side 12 times and the debit side
// never -- because reading it the wrong way round would reverse every transfer in the ledger and
// still look plausible. So From is the header account and To is the GENENTRY debit, which costs
// one extra call per transfer.
//
// Only '*GENENTRY' rows are read. Module_LdgrEntries='X' is the document's own user-typed line
// rather than a GL posting (see import-vendor-bill-gl.js).
//
// STATUS. Live leaves it null on a live transfer and sets VOID on a cancelled one -- 907 and 24
// respectively. This app stores 'open'/'void' and its route treats anything that is not 'void' as
// active, so null maps to 'open'. Checked against live before writing rather than after a
// screenshot: storing live's labels verbatim is what hid 690 cheques and 1,896 transfer orders
// earlier in this migration.
//
// IDEMPOTENT: matches on ft_no and never edits an existing row.
//
//   node src/db/import-fund-transfers.js --dry-run
//   node src/db/import-fund-transfers.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const PAGE = 200;
const CONCURRENCY = 6;

const norm = (s) => (s || '').toString().trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));
const numN = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const dateN = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? String(v).slice(0, 10) : null);
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
    } catch (e) { clearTimeout(timer); last = e; await sleep(1200 * (a + 1)); }
  }
  throw last;
}

// Two consecutive empty pages end the list; one short page under load does not.
async function fetchAll(token, ep, where, label) {
  const rows = [];
  let emptyStreak = 0;
  for (let off = 0; off < 100000; off += PAGE) {
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
  console.log(DRY_RUN ? 'DRY RUN -- report only.\n' : 'APPLYING.\n');

  const token = await login();

  const coa = await fetchAll(token, 'get_chart_of_accounts', null, 'chart of accounts');
  const [localCoa] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts');
  const byCode = new Map(localCoa.map((a) => [norm(a.account_code), a.id]));
  const byName = new Map(localCoa.map((a) => [norm(a.account_name), a.id]));
  const acctByLivePk = new Map();
  for (const a of coa) {
    const id = byCode.get(norm(a.UserPK_COA)) || byName.get(norm(a.Title_COA));
    if (id) acctByLivePk.set(a.SysPK_COA, id);
  }
  console.log(`chart of accounts: live ${coa.length} | resolved locally ${acctByLivePk.size}`);

  const transfers = await fetchAll(token, 'get_transactions', { Module_TransH: 'FUNDTRANSFER' }, 'fund transfers');
  console.log(`live fund transfers: ${transfers.length}`);

  const [existing] = await pool.query('SELECT ft_no FROM fund_transfers');
  const have = new Set(existing.map((f) => norm(f.ft_no)));
  const work = transfers.filter((t) => t.UserPK_TransH && dateN(t.DateCreated_TransH) && !have.has(norm(t.UserPK_TransH)));
  console.log(`already here: ${have.size} | to import: ${work.length}\n`);

  const rows = [];
  const unknownStatus = new Map();
  let noTo = 0; let noFrom = 0; let failed = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor; cursor += 1;
      if (i >= work.length) return;
      const t = work[i];

      let entries = [];
      try {
        entries = listRows(await api(token, 'get_transaction_ledger_entries', {
          where: { SysFK_TransH_LdgrEntries: t.SysPK_TransH }, limit: 50, offset: 0,
        }));
      } catch { failed += 1; continue; }

      const gen = entries.filter((e) => isGlPosting(e.Module_LdgrEntries));
      const debit = gen.find((e) => numN(e.DRAmount_LdgrEntries) > 0);
      const credit = gen.find((e) => numN(e.CRAmount_LdgrEntries) > 0);

      // From is the header account, To is whatever the GL debited. A voided transfer often has
      // no GL at all, so To simply stays unknown rather than being guessed from the header.
      const fromId = acctByLivePk.get(t.SysFK_COA_TransH)
        || (credit ? acctByLivePk.get(credit.SysFK_COA_LdgrEntries) : null) || null;
      const toId = debit ? acctByLivePk.get(debit.SysFK_COA_LdgrEntries) || null : null;
      if (!fromId) noFrom += 1;
      if (!toId) noTo += 1;

      const raw = t.Status_TransH === null || t.Status_TransH === undefined || t.Status_TransH === ''
        ? 'OPEN' : String(t.Status_TransH).toUpperCase();
      const status = { OPEN: 'open', VOID: 'void' }[raw];
      if (!status) { unknownStatus.set(t.Status_TransH, (unknownStatus.get(t.Status_TransH) || 0) + 1); continue; }

      rows.push([
        String(t.UserPK_TransH).slice(0, 40), dateN(t.DateCreated_TransH), fromId, toId,
        numN(t.TotalAmount_TransH) || numN(debit?.DRAmount_LdgrEntries),
        t.Memo_TransH ? String(t.Memo_TransH).slice(0, 1000) : null, status,
      ]);
      if (rows.length % 200 === 0) console.log(`  ...${rows.length}/${work.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nprepared ${rows.length} | no From account ${noFrom} | no To account ${noTo} | failed to fetch ${failed}`);
  if (unknownStatus.size) {
    console.log('\n!! live statuses this app has no mapping for -- SKIPPED, not guessed:');
    for (const [s, n] of unknownStatus) console.log(`   ${JSON.stringify(s)} x${n}`);
  }

  let inserted = 0;
  if (!DRY_RUN && rows.length) {
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const ph = batch.map(() => '(?,?,?,?,?,?,?)').join(',');
      const [r] = await pool.query(
        `INSERT IGNORE INTO fund_transfers (ft_no, date_created, from_account_id, to_account_id, amount, memo, status)
         VALUES ${ph}`, batch.flat()
      );
      inserted += r.affectedRows; // rows accepted, not rows sent
    }
  }

  const [[after]] = await pool.query(
    `SELECT COUNT(*) n, SUM(status='open') open_n, SUM(status='void') void_n,
            SUM(from_account_id IS NULL) nf, SUM(to_account_id IS NULL) nt, SUM(amount) amt
       FROM fund_transfers`
  );
  console.log(`\n${DRY_RUN ? 'Would insert' : 'Inserted'} ${DRY_RUN ? rows.length : inserted}`);
  console.log(`fund_transfers now: ${after.n} (open ${after.open_n}, void ${after.void_n})`);
  console.log(`  missing From ${after.nf} | missing To ${after.nt} | total ${Number(after.amt || 0).toLocaleString()}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
