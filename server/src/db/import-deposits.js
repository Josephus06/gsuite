// Migrates live's Bank Deposits (Accounting > Deposits, BD-####) into `bank_deposits`.
//
// The module already existed here -- routes, list, view, GL -- with an empty table. Live holds
// 22,090 of them under Module_TransH='DEPOSIT', and their numbers are already in this app's
// BD-#### format, so they carry across unchanged.
//
// STATUS. Live says OPEN / VOID; this app stores 'open' / 'void' and the list page's
// STATUS_LABELS only knows those two. Storing live's labels verbatim would render every row as a
// blank or raw status and make the filter match nothing -- the same mistake that hid 690 cheques
// and 1,896 transfer orders earlier in this migration. Checked against live before writing:
// 3,993 OPEN and 7 VOID in the first 4,000, no third value.
//
// WHAT IS NOT IMPORTED, and why. A deposit here can list the customer payments it rolls up
// (customer_payments.deposit_id). Live does not expose that composition: its deposit carries only
// a header and two GL lines (debit bank, credit the offset), there is no per-payment line on the
// document, and no get_deposits-style endpoint exists -- get_deposits, get_bank_deposits,
// get_deposit_details, get_transaction_deposits and get_deposit_payments all 404, and the
// transaction includes return nothing. So the deposits arrive as headers with their totals, which
// is exactly what live's own list shows. No payment is marked deposited, because inventing that
// linkage would silently take payments out of the not-yet-deposited pool.
//
// IDEMPOTENT: matches on bd_no and never edits an existing row.
//
//   node src/db/import-deposits.js --dry-run
//   node src/db/import-deposits.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const PAGE = 200;
const CHUNK = 500;

const norm = (s) => (s || '').toString().trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));
const numN = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const dateN = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? String(v).slice(0, 10) : null);

// Live's display label -> this app's stored value. Anything unexpected is reported rather than
// guessed at, so a new live status cannot quietly become an unfilterable row.
const STATUS = { OPEN: 'open', VOID: 'void' };

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
    if (rows.length % 4000 === 0) console.log(`  ...${label} ${rows.length}`);
  }
  return rows;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- report only.\n' : 'APPLYING.\n');

  const token = await login();

  // Bank accounts: live's chart of accounts key -> this app's account id, matched on code.
  const coa = await fetchAll(token, 'get_chart_of_accounts', null, 'chart of accounts');
  const [localCoa] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts');
  const byCode = new Map(localCoa.map((a) => [norm(a.account_code), a.id]));
  const byName = new Map(localCoa.map((a) => [norm(a.account_name), a.id]));
  const acctByLivePk = new Map();
  for (const a of coa) {
    const id = byCode.get(norm(a.UserPK_COA)) || byName.get(norm(a.Title_COA));
    if (id) acctByLivePk.set(a.SysPK_COA, id);
  }
  console.log(`chart of accounts: live ${coa.length} | resolved locally ${acctByLivePk.size}\n`);

  const deposits = await fetchAll(token, 'get_transactions', { Module_TransH: 'DEPOSIT' }, 'deposits');
  console.log(`\nlive deposits: ${deposits.length}`);

  const [existing] = await pool.query('SELECT bd_no FROM bank_deposits');
  const have = new Set(existing.map((d) => norm(d.bd_no)));
  console.log(`already here: ${have.size}`);

  const unknownStatus = new Map();
  const rows = [];
  let noAccount = 0;
  for (const d of deposits) {
    const no = d.UserPK_TransH;
    const date = dateN(d.DateCreated_TransH);
    if (!no || !date || have.has(norm(no))) continue;
    const status = STATUS[String(d.Status_TransH || '').toUpperCase()];
    if (!status) {
      unknownStatus.set(d.Status_TransH, (unknownStatus.get(d.Status_TransH) || 0) + 1);
      continue;
    }
    const accountId = acctByLivePk.get(d.SysFK_COA_TransH) || null;
    if (!accountId) noAccount += 1;
    rows.push([
      String(no).slice(0, 40), date, accountId,
      d.Memo_TransH ? String(d.Memo_TransH).slice(0, 1000) : null,
      numN(d.TotalAmount_TransH), status,
    ]);
    have.add(norm(no));
  }

  console.log(`to insert: ${rows.length} | of those with no matching bank account: ${noAccount}`);
  if (unknownStatus.size) {
    console.log('\n!! live statuses this app has no mapping for -- SKIPPED, not guessed:');
    for (const [s, n] of unknownStatus) console.log(`   ${JSON.stringify(s)} x${n}`);
  }

  let inserted = 0;
  if (!DRY_RUN) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const batch = rows.slice(i, i + CHUNK);
      const ph = batch.map(() => '(?,?,?,?,?,?)').join(',');
      const [r] = await pool.query(
        `INSERT IGNORE INTO bank_deposits (bd_no, date_created, account_id, memo, total_amount, status)
         VALUES ${ph}`, batch.flat()
      );
      inserted += r.affectedRows; // rows accepted, not rows sent
    }
  }

  const [[after]] = await pool.query(
    "SELECT COUNT(*) n, SUM(status='open') open_n, SUM(status='void') void_n, SUM(total_amount) amt FROM bank_deposits"
  );
  console.log(`\n${DRY_RUN ? 'Would insert' : 'Inserted'} ${DRY_RUN ? rows.length : inserted}`);
  console.log(`bank_deposits now: ${after.n} (open ${after.open_n}, void ${after.void_n}) | total ${Number(after.amt || 0).toLocaleString()}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
