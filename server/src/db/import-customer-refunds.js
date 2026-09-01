// Migrates Customer Refunds (CRFND-####) created in the given window. A refund is a
// get_transactions record with Module_TransH='CUSTREFUND'; the payments it refunded are in its
// `transaction_transactionledgertransactions` include (SysFK_TransHSL_LdgrTr = the payment's pk,
// Amount_LdgrTr = amount refunded, AmountDue_LdgrTr = the payment's original amount). It debits
// A/R Trade (12100) and credits Customer Refund (10005). Customers/payments that were never
// migrated are created-on-miss (customer) or kept as a text reference (payment_no).
//
//   node src/db/import-customer-refunds.js --from=2026-01-01 --to=2026-12-31 --dry-run
//   node src/db/import-customer-refunds.js --from=2026-01-01 --to=2026-12-31
const pool = require('../db');
const { upperCustomerName } = require('../lib/customerName');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
function argVal(name, def) { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; }
const FROM = argVal('from', '2026-01-01');
const TO = argVal('to', '2026-12-31');
const DRY_RUN = process.argv.includes('--dry-run');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clean = (v) => (v == null ? null : String(v).trim() || null);
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
async function api(token, ep, payload, ms = 40000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: ctl.signal });
    clearTimeout(t); return await r.json();
  } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
}
async function apiRetry(token, ep, payload, attempts = 3) {
  let last; for (let a = 0; a < attempts; a += 1) {
    try { return await api(token, ep, payload); } catch (e) { last = e; await sleep(1200 * (a + 1)); }
  }
  throw last;
}
function refundStatus(live) {
  const s = (live || '').toLowerCase();
  return (s.includes('void') || s.includes('cancel')) ? 'voided' : 'posted';
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Customer Refunds | window ${FROM}..${TO}${DRY_RUN ? ' | DRY RUN' : ''}\n`);

  // Resolution maps.
  const [custs] = await pool.query('SELECT id, name FROM customers');
  const custByName = new Map(custs.map((c) => [norm(c.name), c.id]));
  const [deps] = await pool.query('SELECT id, name FROM departments');
  const depByName = new Map(deps.map((d) => [norm(d.name), d.id]));
  const [meths] = await pool.query('SELECT id, name FROM payment_methods');
  const methByName = new Map(meths.map((m) => [norm(m.name), m.id]));
  const [pays] = await pool.query('SELECT id, customer_payment_no FROM customer_payments');
  const payByNo = new Map(pays.map((x) => [x.customer_payment_no, x.id]));
  const [users] = await pool.query("SELECT id, display_name FROM users");
  const userByName = new Map(users.map((u) => [norm(u.display_name), u.id]));
  const [[acc]] = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '10005'");
  const [[ar]] = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '12100'");
  const [[headOffice]] = await pool.query("SELECT id FROM locations WHERE location_name = 'Head Office' LIMIT 1");

  let custCreated = 0;
  async function resolveCustomer(name, tin) {
    const key = norm(name); if (!key) return null;
    if (custByName.has(key)) return custByName.get(key);
    if (DRY_RUN) { custCreated += 1; return null; }
    const [[mx]] = await pool.query("SELECT COALESCE(MAX(CAST(SUBSTRING(customer_code,6) AS UNSIGNED)),0)+1 AS n FROM customers WHERE customer_code REGEXP '^CUST-[0-9]{1,6}$'");
    const code = `CUST-${String(mx.n).padStart(4, '0')}`;
    const [r] = await pool.query('INSERT INTO customers (customer_code, name, tin) VALUES (?,?,?)', [code, upperCustomerName(trunc(clean(name), 255)), trunc(tin, 60)]);
    custByName.set(key, r.insertId); custCreated += 1; return r.insertId;
  }

  const [have] = await pool.query('SELECT customer_refund_no FROM customer_refunds');
  const haveRef = new Set(have.map((r) => r.customer_refund_no));

  const token = await login();

  // Page CUSTREFUND transactions, keep the window.
  const all = [];
  for (let off = 0; off < 5000; off += 200) {
    const list = listRows(await apiRetry(token, 'get_transactions', { where: { Module_TransH: 'CUSTREFUND' }, limit: 200, offset: off }));
    if (!list.length) break; all.push(...list); if (list.length < 200) break;
  }
  const targets = all.filter((r) => { const d = day(r.DateCreated_TransH); return d >= FROM && d <= TO && !haveRef.has(r.UserPK_TransH); });
  console.log(`Found ${all.length} refund(s); ${targets.length} in window to import.\n`);

  let created = 0, lineCount = 0, payMatched = 0, failed = 0;
  for (const ref of targets) {
    let det;
    try {
      det = listRows(await apiRetry(token, 'get_transactions', {
        where: { SysPK_TransH: ref.SysPK_TransH },
        include: ['transaction_transactionledgertransactions', 'transaction_transactionledgerentries', 'transaction_customer', 'transaction_account', 'transaction_department'],
      }))[0];
    } catch (e) { failed += 1; continue; }
    if (!det) { failed += 1; continue; }

    const custName = det.transaction_customer?.Name_Cust || det.transaction_account?.Name_Accnt || det.Name_Cust || det.Name_Accnt;
    const tin = det.transaction_customer?.TIN_Cust || det.transaction_account?.TIN_Accnt || null;
    const customerId = await resolveCustomer(custName, tin);
    if (!customerId && !DRY_RUN) { console.warn(`  [skip] ${ref.UserPK_TransH}: no customer (${custName})`); failed += 1; continue; }

    const depName = det.transaction_department?.Name_Dept;
    const departmentId = depByName.get(norm(depName)) || null;
    const methodId = methByName.get(norm(ref.PaymentMethod_TransH)) || null;
    const issuedBy = userByName.get(norm(ref.PreparedBy_TransH)) || null;
    const officeLocationId = headOffice?.id || null;

    // Applied payments.
    const lts = det.transaction_transactionledgertransactions || [];
    const appLines = [];
    for (const lt of lts) {
      let payNo = null;
      try { const pmt = listRows(await apiRetry(token, 'get_transactions', { where: { SysPK_TransH: lt.SysFK_TransHSL_LdgrTr } }))[0]; payNo = pmt?.UserPK_TransH || null; }
      catch (e) { /* keep null */ }
      const localPayId = payNo ? (payByNo.get(payNo) || null) : null;
      if (localPayId) payMatched += 1;
      appLines.push({ payment_id: localPayId, payment_no: payNo, original: num(lt.AmountDue_LdgrTr), refund: num(lt.Amount_LdgrTr) });
    }

    if (DRY_RUN) { console.log(`  ${ref.UserPK_TransH} | ${day(ref.DateCreated_TransH)} | ${custName} | ${ref.TotalAmount_TransH} | payments: ${appLines.map((a) => `${a.payment_no}(${a.refund})`).join(', ')}`); created += 1; continue; }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO customer_refunds
           (customer_refund_no, date_created, customer_id, department_id, office_location_id, account_id,
            ar_account_id, payment_method_id, refund_amount, memo, issued_by_user_id, status, created_by_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ref.UserPK_TransH, day(ref.DateCreated_TransH) || FROM, customerId, departmentId, officeLocationId,
         acc?.id || null, ar?.id || null, methodId, num(ref.TotalAmount_TransH), trunc(ref.Memo_TransH, 500),
         issuedBy, refundStatus(ref.Status_TransH), issuedBy]);
      const refundId = r.insertId;
      for (const a of appLines) {
        await conn.query(
          'INSERT INTO customer_refund_lines (customer_refund_id, customer_payment_id, payment_no, original_amount, refund_amount) VALUES (?,?,?,?,?)',
          [refundId, a.payment_id, trunc(a.payment_no, 60), a.original, a.refund]);
        lineCount += 1;
      }
      await conn.commit();
      haveRef.add(ref.UserPK_TransH); created += 1;
    } catch (e) { await conn.rollback(); failed += 1; console.error(`  [error] ${ref.UserPK_TransH}: ${e.message}`); }
    finally { conn.release(); }
  }

  console.log(`\nDone. ${created} refund(s), ${lineCount} line(s). Payments matched to local: ${payMatched}. Customers created: ${custCreated}. Failures: ${failed}.`);
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
