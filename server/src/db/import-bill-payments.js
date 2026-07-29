// Migrates Bill Payments (BPAY-####) -- the cash that settles a Vendor Bill. Run AFTER
// import-vendor-bills.js. A payment's sl_pk on the live list IS the vendor-bill number it pays,
// so we match it straight to a local vendor_bill by bill_no (which also scopes payments to the
// bills we imported -- i.e. to in-window POs' bills). One bill_payment_line per payment links it
// to that bill.
//
//   get_bill_payments {searchKey,limit,offset} -> payment headers (user_pk=BPAY#, sl_pk=VB#)
//
// bank_account_id / ap_account_id are NOT NULL FKs into chart_of_accounts; live only names the
// bank in Title_COA, so we default to Cash in Bank (11000) / Accounts Payable-Trade (20100).
// Resumable (skips payments already imported) + idempotent.
//   node src/db/import-bill-payments.js --from=2026-01-01 --to=2026-07-31 --dry-run
//   node src/db/import-bill-payments.js --from=2026-01-01 --to=2026-07-31
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
function argVal(name, def) { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; }
const FROM = argVal('from', '2026-01-01');
const TO = argVal('to', '2026-07-31');
const DRY_RUN = process.argv.includes('--dry-run');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const trunc = (v, n) => (v == null ? null : String(v).slice(0, n));
const day = (v) => (v || '').toString().slice(0, 10);
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase());
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  return (await r.json())?.data?.token;
}
async function api(token, ep, payload, ms = 60000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: ctl.signal });
    clearTimeout(t); return await r.json();
  } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
}
async function apiRetry(token, ep, payload, attempts = 4) {
  let last; for (let a = 0; a < attempts; a += 1) {
    try { return await api(token, ep, payload, 60000 + a * 20000); }
    catch (e) { last = e; await sleep(1200 * (a + 1)); }
  }
  throw last;
}
function paymentStatus(live) {
  const s = (live || '').toUpperCase();
  if (s.includes('VOID') || s.includes('CANCEL')) return 'voided';
  return 'posted';
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Bill Payments | window ${FROM}..${TO}${DRY_RUN ? ' | DRY RUN' : ''}\n`);

  const [vbs] = await pool.query('SELECT id, bill_no, supplier_id_placeholder FROM (SELECT vb.id, vb.bill_no, po.supplier_id AS supplier_id_placeholder FROM vendor_bills vb JOIN purchase_orders po ON po.id = vb.purchase_order_id) t');
  const vbByNo = new Map(vbs.map((v) => [v.bill_no, v]));
  const [sups] = await pool.query('SELECT id, name FROM suppliers');
  const supByName = new Map(sups.map((s) => [norm(s.name), s.id]));
  const [methods] = await pool.query('SELECT id, name FROM payment_methods');
  const methodByName = new Map(methods.map((m) => [norm(m.name), m.id]));
  const cashMethodId = methodByName.get('cash') || methods[0]?.id;
  const [[bank]] = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '11000' LIMIT 1");
  const [[ap]] = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '20100' LIMIT 1");
  const bankId = bank ? bank.id : null;
  const apId = ap ? ap.id : null;
  console.log(`Local: ${vbByNo.size} vendor bill(s). Bank COA=${bankId}, AP COA=${apId}, cash method=${cashMethodId}.`);

  const [have] = await pool.query('SELECT bill_payment_no FROM bill_payments');
  const havePay = new Set(have.map((r) => r.bill_payment_no));

  const token = await login();

  // Page all bill payments; keep those in the window whose bill we imported.
  const pays = [];
  let scanned = 0, noBill = 0;
  for (let offset = 0; offset < 120000; offset += 200) {
    let list;
    try { list = listRows(await apiRetry(token, 'get_bill_payments', { searchKey: '', limit: 200, offset })); }
    catch (e) { console.warn(`  page ${offset} failed: ${e.message}`); break; }
    if (!list.length) break;
    for (const bp of list) {
      scanned += 1;
      const d = day(bp.DateCreated_TransH);
      if (d < FROM || d > TO) continue;
      const vb = vbByNo.get(bp.sl_pk);
      if (!vb) { noBill += 1; continue; } // payment for a bill outside our scope
      pays.push({ bp, vb });
    }
    if (list.length < 200) break;
  }
  console.log(`Scanned ${scanned} payment(s); ${pays.length} in window for imported bills (${noBill} for out-of-scope bills).`);

  const targets = pays.filter(({ bp }) => !havePay.has(bp.user_pk));
  console.log(`${targets.length} bill payment(s) to import (new only).\n`);

  if (DRY_RUN) {
    const total = targets.reduce((s, { bp }) => s + num(bp.TotalAmount_TransH), 0);
    console.log(`Would import ${targets.length} payment(s) totalling ${total.toFixed(2)}.`);
    await pool.end();
    return;
  }

  let created = 0, failed = 0;
  for (const { bp, vb } of targets) {
    const supplierId = supByName.get(norm(bp.Name_Accnt)) || vb.supplier_id_placeholder || null;
    if (!supplierId || !bankId || !cashMethodId) { failed += 1; continue; } // NOT NULL guards
    const methodId = methodByName.get(norm(bp.PaymentMethod_TransH)) || cashMethodId;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO bill_payments (bill_payment_no, date_created, payment_type, supplier_id, payee_name,
           ap_account_id, bank_account_id, payment_method_id, reference_no, check_date, check_no, memo,
           total_amount, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [bp.user_pk, day(bp.DateCreated_TransH) || FROM, trunc(bp.Type_TransH, 60) || 'Bill Payment', supplierId,
         trunc(bp.Name_Accnt, 255), apId, bankId, methodId, trunc(bp.ReferrenceNO_TransH, 191),
         day(bp.CheckDate_TransH) || null, trunc(bp.CheckNo_TransH, 60), trunc(bp.Memo_TransH, 500),
         num(bp.TotalAmount_TransH), paymentStatus(bp.Status_TransH)]);
      const payId = r.insertId;
      await conn.query(
        'INSERT INTO bill_payment_lines (bill_payment_id, vendor_bill_id, applied_amount) VALUES (?,?,?)',
        [payId, vb.id, num(bp.TotalAmount_TransH)]);
      await conn.commit();
      havePay.add(bp.user_pk); created += 1;
      if (created % 200 === 0) console.log(`  ...${created}/${targets.length} payments`);
    } catch (e) { await conn.rollback(); failed += 1; if (failed <= 5) console.error(`  [error] ${bp.user_pk}: ${e.message}`); }
    finally { conn.release(); }
  }

  console.log(`\nDone. ${created} bill payment(s) imported. Failures: ${failed}.`);
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
