// Read-only: every customer payment in the source (get_customer_payments) for a date window,
// against T1S's customer_payments by number. Reports what is missing, why (void at source,
// customer not in T1S), and amount/status differences. Writes the missing list to a JSON file
// for import-customer-payments.js to act on. Changes nothing.
//
//   node src/db/compare-customer-payments.js --from=2026-01-01 --to=2026-12-31 [--refresh] [--out=missing.json]
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');
const { fetchWindow, isVoidOrCancelled } = require('./lib/liveWindow');

const SITE = 'http://gsuite.graphicstar.com.ph';
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const FROM = arg('from', '2026-01-01'); const TO = arg('to', '2026-12-31');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clean = (s) => (s || '').toString().trim().replace(/\s+/g, ' ');

(async () => {
  const l = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  const token = (await l.json())?.data?.token;
  if (!token) throw new Error('Source login failed');
  const rows = await fetchWindow(token, { endpoint: 'get_customer_payments', from: FROM, to: TO, keyField: 'cp_pk',
    refresh: process.argv.includes('--refresh'), onProgress: (m) => console.log(m) });

  const [mine] = await pool.query('SELECT customer_payment_no no, payment_amount amt, status FROM customer_payments WHERE customer_payment_no LIKE \'PAY-%\'');
  const local = new Map(mine.map((r) => [r.no, r]));
  const [custs] = await pool.query('SELECT LOWER(name) n FROM customers');
  const custSet = new Set(custs.map((c) => clean(c.n)));

  const seen = new Set();
  const stats = { source: 0, void: 0, present: 0, missing: 0, missingCustomerNowExists: 0, missingNoCustomer: 0, amountDiff: 0 };
  const missing = []; const diffs = [];
  for (const p of rows) {
    if (!p.cp_pk || seen.has(p.cp_pk)) continue;
    seen.add(p.cp_pk);
    stats.source += 1;
    if (isVoidOrCancelled(p.Status_TransH)) { stats.void += 1; continue; }
    const t = local.get(p.cp_pk);
    if (t) {
      stats.present += 1;
      if (Math.abs(num(t.amt) - num(p.TotalAmount_TransH)) > 0.005) { stats.amountDiff += 1; diffs.push([p.cp_pk, num(p.TotalAmount_TransH), num(t.amt)]); }
      continue;
    }
    stats.missing += 1;
    const hasCust = custSet.has(clean(p.Name_Cust).toLowerCase());
    if (hasCust) stats.missingCustomerNowExists += 1; else stats.missingNoCustomer += 1;
    missing.push({ no: p.cp_pk, date: String(p.DateCreated_TransH).slice(0, 10), customer: clean(p.Name_Cust), amount: num(p.TotalAmount_TransH), customerInT1S: hasCust });
  }
  const sum = (a) => a.reduce((s, x) => s + x.amount, 0).toFixed(2);
  console.log(`\n${FROM}..${TO}`, JSON.stringify(stats));
  console.log(`missing amount ${sum(missing)} (customer in T1S now: ${sum(missing.filter((m) => m.customerInT1S))}; customer still absent: ${sum(missing.filter((m) => !m.customerInT1S))})`);
  const byMonth = {};
  for (const m of missing) byMonth[m.date.slice(0, 7)] = (byMonth[m.date.slice(0, 7)] || 0) + 1;
  console.log('missing by month', JSON.stringify(byMonth));
  if (diffs.length) console.log('amount diffs (first 10)', JSON.stringify(diffs.slice(0, 10)));
  console.log('examples', JSON.stringify(missing.slice(0, 5)));
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(missing));
  await pool.end();
})().catch(async (e) => { console.error('FAILED', e.message); process.exit(1); });
