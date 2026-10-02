// Read-only: every customer payment in the source for a date window, compared FIELD BY FIELD with
// T1S's (by payment number) -- date, customer, amount, applied / unapplied, OR #, receipt type,
// payment method, payment type, status, memo, prepared by, issued by, office location.
// compare-customer-payments.js answers "is it there, for the right amount"; this answers "are its
// details the same". Changes nothing.
//
// Values are normalised before comparing, where the two systems spell the same thing differently:
// receipt type CR / OR / PR = Collection / Official / Provisional Receipt; status NOT DEPOSITED =
// not_deposited; payment type with or without "Payment" (Full = Full Payment, Down Payment = Downpayment); names and memos by
// case and spacing.
//
// A status that is 'deposited' in T1S but NOT DEPOSITED at the source is reported apart, not as a
// mismatch, when the T1S payment sits on a Bank Deposit made in T1S after go-live -- the deposit
// happened here, where the source no longer sees it.
//
//   node src/db/compare-customer-payment-details.js --from=2026-09-01 --to=2026-09-30 [--refresh] [--out=diffs.json]
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');
const { fetchWindow } = require('./lib/liveWindow');

const SITE = 'http://gsuite.graphicstar.com.ph';
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const FROM = arg('from', '2026-09-01'); const TO = arg('to', '2026-09-30'); const OUT = arg('out', null);
const money = (v) => Number(Number(v || 0).toFixed(2));
const txt = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().toLowerCase();
const day = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');
const RECEIPT = { cr: 'collection receipt', or: 'official receipt', pr: 'provisional receipt' };
const receipt = (v) => RECEIPT[txt(v)] || txt(v);
// Full / Full Payment, Partial / Partial Payment, Balance / Balance Payment, Down Payment / Downpayment.
const ptype = (v) => txt(v).replace(/\s+/g, '').replace(/payment$/, '');
const status = (v) => txt(v).replace(/\s+/g, '_');

(async () => {
  const l = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  const token = (await l.json())?.data?.token;
  if (!token) throw new Error('Source login failed');
  const rows = await fetchWindow(token, { endpoint: 'get_customer_payments', from: FROM, to: TO, keyField: 'cp_pk',
    refresh: process.argv.includes('--refresh'), onProgress: () => {} });

  const [mine] = await pool.query(
    `SELECT cp.customer_payment_no AS no, cp.date_created, c.name AS customer, cp.payment_amount, cp.applied_amount, cp.unapplied_amount,
            cp.or_no, cp.receipt_type, pm.name AS method, cp.payment_type, cp.status, cp.memo, cp.prepared_by_name,
            cp.issued_by_name, loc.location_name, cp.deposit_id, bd.created_at AS deposit_made
       FROM customer_payments cp
       LEFT JOIN customers c ON c.id = cp.customer_id
       LEFT JOIN payment_methods pm ON pm.id = cp.payment_method_id
       LEFT JOIN locations loc ON loc.id = cp.office_location_id
       LEFT JOIN bank_deposits bd ON bd.id = cp.deposit_id
      WHERE cp.customer_payment_no LIKE 'PAY-%' AND cp.date_created BETWEEN ? AND ?`, [FROM, TO]);
  const local = new Map(mine.map((r) => [r.no, r]));

  // field: [source value, T1S value, compare]
  const FIELDS = {
    date: (s, t) => [day(s.DateCreated_TransH), day(t.date_created)],
    customer: (s, t) => [txt(s.Name_Cust), txt(t.customer)],
    amount: (s, t) => [money(s.TotalAmount_TransH), money(t.payment_amount)],
    applied: (s, t) => [money(s.AppliedPayments_TransH), money(t.applied_amount)],
    unapplied: (s, t) => [money(s.UnappliedPayments_TransH), money(t.unapplied_amount)],
    or_no: (s, t) => [txt(s.ORNo_TransH), txt(t.or_no)],
    receipt_type: (s, t) => [receipt(s.OrderConfirmation_TransH), receipt(t.receipt_type)],
    payment_method: (s, t) => [txt(s.PaymentMethod_TransH), txt(t.method)],
    payment_type: (s, t) => [ptype(s.Type_TransH), ptype(t.payment_type)],
    status: (s, t) => [status(s.Status_TransH), status(t.status)],
    memo: (s, t) => [txt(s.Memo_TransH), txt(t.memo)],
    prepared_by: (s, t) => [txt(s.PreparedBy_TransH), txt(t.prepared_by_name)],
    issued_by: (s, t) => [txt(s.IssuedBy_TransH), txt(t.issued_by_name)],
    location: (s, t) => [txt(s.Name_Loc), txt(t.location_name)],
  };
  const counts = Object.fromEntries(Object.keys(FIELDS).map((f) => [f, 0]));
  const examples = Object.fromEntries(Object.keys(FIELDS).map((f) => [f, []]));
  const diffs = [];
  let compared = 0; let missing = 0; let fullyMatching = 0; let depositedInT1S = 0;
  const seen = new Set();
  for (const s of rows) {
    if (!s.cp_pk || seen.has(s.cp_pk)) continue;
    seen.add(s.cp_pk);
    const t = local.get(s.cp_pk);
    if (!t) { missing += 1; continue; }
    compared += 1;
    const bad = [];
    for (const [f, fn] of Object.entries(FIELDS)) {
      const [a, b] = fn(s, t);
      if (a === b) continue;
      if (f === 'status' && a === 'not_deposited' && b === 'deposited' && t.deposit_made && day(t.deposit_made) >= '2026-10-01') { depositedInT1S += 1; continue; }
      counts[f] += 1;
      if (examples[f].length < 4) examples[f].push(`${s.cp_pk}: source "${a}" / T1S "${b}"`);
      bad.push({ field: f, source: a, t1s: b });
    }
    if (bad.length) diffs.push({ no: s.cp_pk, diffs: bad }); else fullyMatching += 1;
  }

  console.log(`${FROM}..${TO}: source ${seen.size}, compared ${compared}, not in T1S ${missing}`);
  console.log(`Every detail matches: ${fullyMatching} of ${compared}`);
  if (depositedInT1S) console.log(`Deposited in T1S after go-live (source still says NOT DEPOSITED -- expected): ${depositedInT1S}`);
  console.log('\nMismatches by field:');
  for (const [f, n] of Object.entries(counts)) {
    console.log(`  ${f.padEnd(15)} ${String(n).padStart(5)}${n ? `   e.g. ${examples[f].join(' | ')}` : ''}`);
  }
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(diffs, null, 1)); console.log(`\nAll ${diffs.length} payment(s) with a difference -> ${OUT}`); }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
