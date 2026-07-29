// Migrates Commission Vouchers (COMVCH-####) from live and links each to the Commission Payables
// it released, so both modules' Related Records line up. A voucher's DR entries reference a
// payable's ComPay LINE pk (SysFK_ComPay_LdgrEntries), so we first build a ComPay-pk -> CP-number
// map from every payable's detail, then read each voucher's lines/expenses off its ledger entries.
//
// IMPORTANT: this does NOT re-settle the payables -- their amount_paid/status were already migrated
// verbatim from live (which already reflects these vouchers). It only records the voucher + links.
//
//   node src/db/import-commission-vouchers.js --dry-run
//   node src/db/import-commission-vouchers.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v) => Number(num(v).toFixed(2));
const day = (v) => (v || '').toString().slice(0, 10);
const norm = (s) => (s == null ? '' : String(s).toLowerCase().replace(/[^a-z0-9ñ]/g, ''));
const trunc = (v, n) => (v == null ? null : String(v).slice(0, n));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (res?.data || []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  const b = await r.json();
  if (!b?.data?.token) throw new Error(`Login failed: ${b?.message}`);
  return b.data.token;
}
async function apiOnce(token, ep, payload, ms = 40000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload), signal: ctl.signal });
    clearTimeout(t); return await r.json();
  } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
}
async function api(token, ep, payload) {
  let last; for (let a = 0; a < 4; a += 1) { try { return await apiOnce(token, ep, payload); } catch (e) { last = e; await sleep(1200 * (a + 1)); } }
  throw last;
}
function voucherStatus(live) { return (live || '').toUpperCase().includes('VOID') ? 'void' : 'posted'; }

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Commission Vouchers${DRY_RUN ? ' | DRY RUN' : ''}\n`);

  const [pays] = await pool.query('SELECT id, commission_payable_no, employee_id FROM commission_payables');
  const payByNo = new Map(pays.map((p) => [p.commission_payable_no, p]));
  const [emps] = await pool.query("SELECT id, CONCAT(first_name, ' ', last_name) AS nm FROM employees");
  const empByName = new Map(emps.map((e) => [norm(e.nm), e.id]));
  const [meths] = await pool.query('SELECT id, name FROM payment_methods');
  const methByName = new Map(meths.map((m) => [norm(m.name), m.id]));
  const [coas] = await pool.query('SELECT id, account_code FROM chart_of_accounts');
  const coaByCode = new Map(coas.map((c) => [c.account_code, c.id]));
  const [have] = await pool.query('SELECT voucher_no FROM commission_vouchers');
  const haveNo = new Set(have.map((r) => r.voucher_no));

  const token = await login();

  // Live COA pk -> code (for resolving ledger-entry accounts).
  const coaPkToCode = new Map();
  for (let off = 0; off < 5000; off += 200) {
    const b = listRows(await api(token, 'get_chart_of_accounts', { searchKey: '', limit: 200, offset: off }));
    if (!b.length) break; b.forEach((c) => coaPkToCode.set(c.SysPK_COA, c.UserPK_COA)); if (b.length < 200) break;
  }
  console.log(`Loaded ${coaPkToCode.size} live COA.`);

  // ComPay LINE pk -> CP number, from every payable's detail.
  const payablesList = [];
  for (let off = 0; off < 5000; off += 100) { const b = listRows(await api(token, 'get_commission_payables', { searchKey: '', limit: 100, offset: off })); if (!b.length) break; payablesList.push(...b); if (b.length < 100) break; }
  const comPayToCp = new Map();
  let mapped = 0;
  for (const cp of payablesList) {
    try {
      const d = listRows(await api(token, 'get_commission_payable', { pk: cp.SysPK_TransH }))[0];
      for (const l of (d?.transaction_commissionpayables || [])) { if (l.SysPK_ComPay) { comPayToCp.set(l.SysPK_ComPay, cp.UserPK_TransH); mapped += 1; } }
    } catch (e) { console.warn(`  ! ComPay map ${cp.UserPK_TransH}: ${e.message}`); }
  }
  console.log(`Built ComPay->CP map (${mapped} line(s)).`);

  const vouchers = [];
  for (let off = 0; off < 5000; off += 100) { const b = listRows(await api(token, 'get_commission_vouchers', { searchKey: '', limit: 100, offset: off })); if (!b.length) break; vouchers.push(...b); if (b.length < 100) break; }
  const targets = vouchers.filter((v) => !haveNo.has(v.UserPK_TransH));
  console.log(`Found ${vouchers.length} voucher(s); ${targets.length} to import.\n`);

  let created = 0; let lineCount = 0; let expCount = 0; let noLink = 0; let failed = 0;
  for (const v of targets) {
    let d;
    try { d = await api(token, 'get_commission_voucher', { pk: v.SysPK_TransH }); }
    catch (e) { console.error(`  [error] ${v.UserPK_TransH}: ${e.message}`); failed += 1; continue; }
    const h = d.data?.[0];
    if (!h) { failed += 1; continue; }

    // Use the posted GENENTRY ledger only. A parallel 'X'-module array carries a zero-amount
    // duplicate of every line that would otherwise mask the real released amount if merged.
    const entries = [];
    for (let i = 1; i < (d.data?.length || 0); i += 1) {
      if (Array.isArray(d.data[i])) entries.push(...d.data[i].filter((g) => (g.Module_LdgrEntries || '').includes('GENENTRY')));
    }
    const cashCoaPk = h.SysFK_COA_TransH;

    // Lines: unique ComPay refs -> local payable, released = DR amount (largest wins; drop zeros).
    const byComPay = new Map();
    for (const g of entries) {
      const cpk = g.SysFK_ComPay_LdgrEntries;
      if (!cpk) continue;
      const amt = num(g.DRAmount_LdgrEntries) || -num(g.CRAmount_LdgrEntries);
      if (!byComPay.has(cpk) || Math.abs(amt) > Math.abs(byComPay.get(cpk))) byComPay.set(cpk, amt);
    }
    const lines = [];
    for (const [cpk, amt] of byComPay) {
      if (!money(amt)) continue; // zero-amount line -- not actually released
      const cpNo = comPayToCp.get(cpk);
      const local = cpNo ? payByNo.get(cpNo) : null;
      if (!local) { noLink += 1; continue; }
      lines.push({ commission_payable_id: local.id, released_amount: money(amt), cpNo });
    }

    // Expenses: non-ComPay, non-cash ledger entries.
    const expenses = [];
    for (const g of entries) {
      if (g.SysFK_ComPay_LdgrEntries) continue;
      if (g.SysFK_COA_LdgrEntries === cashCoaPk) continue; // the cash/bank line
      const code = coaPkToCode.get(g.SysFK_COA_LdgrEntries);
      const accId = code ? coaByCode.get(code) : null;
      if (!accId) continue;
      const dr = num(g.DRAmount_LdgrEntries); const cr = num(g.CRAmount_LdgrEntries);
      const amount = dr > 0 ? money(dr) : -money(cr);
      if (amount) expenses.push({ account_id: accId, amount, description: trunc(g.Particulars_LdgrEntries, 255) });
    }

    const employeeId = empByName.get(norm(h.transaction_employee?.Name_Empl || h.PayeeName_TransH));
    const cashAcctId = coaByCode.get(coaPkToCode.get(cashCoaPk)) || null;
    const methodId = methByName.get(norm(h.PaymentMethod_TransH)) || null;
    const total = money(h.TotalAmount_TransH);
    const status = voucherStatus(h.Status_TransH);

    if (DRY_RUN) {
      console.log(`  ${v.UserPK_TransH} | ${day(h.DateCreated_TransH)} | ${h.transaction_employee?.Name_Empl} | total ${total} | ${lines.length} line(s) [${lines.map((l) => l.cpNo).join(',')}] | ${expenses.length} expense(s) | cash ${coaPkToCode.get(cashCoaPk)}`);
      created += 1; lineCount += lines.length; expCount += expenses.length; continue;
    }
    if (!employeeId) { console.warn(`  [skip] ${v.UserPK_TransH}: employee not found (${h.transaction_employee?.Name_Empl})`); failed += 1; continue; }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO commission_vouchers
           (voucher_no, date_created, employee_id, payee_name, reference_no, memo, payment_method_id,
            cash_bank_account_id, payment_type, date_released, total_payments, status, created_by_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
        [v.UserPK_TransH, day(h.DateCreated_TransH), employeeId, trunc(h.PayeeName_TransH, 255), trunc(h.ReferrenceNO_TransH, 191),
         trunc(h.Memo_TransH, 500), methodId, cashAcctId, 'full', null, total, status]
      );
      const cvId = r.insertId;
      for (const l of lines) { await conn.query('INSERT INTO commission_voucher_lines (commission_voucher_id, commission_payable_id, released_amount) VALUES (?,?,?)', [cvId, l.commission_payable_id, l.released_amount]); lineCount += 1; }
      for (const e of expenses) { await conn.query('INSERT INTO commission_voucher_expenses (commission_voucher_id, account_id, description, amount) VALUES (?,?,?,?)', [cvId, e.account_id, e.description, e.amount]); expCount += 1; }
      await conn.commit();
      haveNo.add(v.UserPK_TransH); created += 1;
    } catch (e) { await conn.rollback(); console.error(`  [error] ${v.UserPK_TransH}: ${e.message}`); failed += 1; }
    finally { conn.release(); }
  }

  console.log(`\nDone. ${created} voucher(s), ${lineCount} line(s), ${expCount} expense(s). Unlinkable lines: ${noLink}. Failures: ${failed}.`);
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
