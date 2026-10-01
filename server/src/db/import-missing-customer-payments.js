// Imports ONLY the source customer payments compare-customer-payments.js found missing from T1S
// (2026-10-01: 492, all 2021-2025, ~3.69M). Insert-only, never replaces an existing payment --
// unlike import-customer-payments.js, which deletes and re-creates by number and so would drop a
// payment's deposit link. A payment whose customer is not in T1S gets that customer created first
// (24 of them: names the earlier customer import did not carry).
//
// Same mapping as import-customer-payments.js: standalone (the source exposes no
// payment->invoice detail), real number/date/OR #/amount/method/location/status.
//
//   node src/db/import-missing-customer-payments.js --years=2021,2022,2023,2024,2025 [--apply]
// Reads /root/match2026/cp-missing-<year>.json and the cached source window
// .live-cache/get_customer_payments_<year>-01-01_<year>-12-31.json. Run on ONE box (droplet).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { upperCustomerName } = require('../lib/customerName');

const APPLY = process.argv.includes('--apply');
const years = (process.argv.find((a) => a.startsWith('--years=')) || '--years=2021,2022,2023,2024,2025').split('=')[1].split(',');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clean = (s) => (s || '').toString().trim().replace(/\s+/g, ' ');
function paymentStatus(live) {
  const s = (live || '').toUpperCase();
  if (s.includes('DEPOSITED') && !s.includes('NOT')) return 'deposited';
  return 'not_deposited';
}

(async () => {
  const want = new Set(); const src = new Map();
  for (const y of years) {
    for (const m of JSON.parse(fs.readFileSync(`/root/match2026/cp-missing-${y}.json`, 'utf8'))) want.add(m.no);
    const cache = path.join(__dirname, '..', '..', '.live-cache', `get_customer_payments_${y}-01-01_${y}-12-31.json`);
    for (const r of JSON.parse(fs.readFileSync(cache, 'utf8'))) if (want.has(r.cp_pk) && !src.has(r.cp_pk)) src.set(r.cp_pk, r);
  }
  const [methods] = await pool.query('SELECT id, name FROM payment_methods');
  const methodByName = new Map(methods.map((m) => [m.name.toUpperCase(), m.id]));
  const [locations] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locations.map((l) => [clean(l.location_name).toLowerCase(), l.id]));
  const [custs] = await pool.query('SELECT id, LOWER(name) n FROM customers');
  const custByName = new Map(custs.map((c) => [clean(c.n), c.id]));
  const [have] = await pool.query("SELECT customer_payment_no no FROM customer_payments WHERE customer_payment_no LIKE 'PAY-%'");
  const exists = new Set(have.map((h) => h.no));

  // A payment with NO customer at the source (24 of the 492) cannot go in: customer_id is NOT NULL.
  // Listed, not guessed at -- which customer paid is accounting's call.
  const blank = [...src.values()].filter((p) => !exists.has(p.cp_pk) && !clean(p.Name_Cust));
  if (blank.length) console.log(`skipped -- no customer at the source: ${blank.length} (${blank.map((p) => `${p.cp_pk} ${String(p.DateCreated_TransH).slice(0, 10)} ${num(p.TotalAmount_TransH).toFixed(2)}`).join(', ')})`);
  const todo = [...src.values()].filter((p) => !exists.has(p.cp_pk) && clean(p.Name_Cust));
  const newCustomers = [...new Set(todo.map((p) => clean(p.Name_Cust)).filter((n) => n && !custByName.has(n.toLowerCase())))];
  const total = todo.reduce((s, p) => s + num(p.TotalAmount_TransH), 0);
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLY' : 'PREVIEW'}`);
  console.log(`missing listed: ${want.size}; found in source cache: ${src.size}; still absent in T1S: ${todo.length} totalling ${total.toFixed(2)}`);
  console.log(`customers to create: ${newCustomers.length}${newCustomers.length ? ` (${newCustomers.slice(0, 8).join('; ')}${newCustomers.length > 8 ? '; ...' : ''})` : ''}`);
  if (!APPLY) { console.log('Preview only. Re-run with --apply.'); await pool.end(); return; }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const n of newCustomers) {
      const [r] = await conn.query('INSERT INTO customers (name, is_active) VALUES (?, 1)', [upperCustomerName(n).slice(0, 200)]);
      custByName.set(n.toLowerCase(), r.insertId);
    }
    let done = 0;
    for (const p of todo) {
      await conn.query(
        `INSERT INTO customer_payments
           (customer_payment_no, date_created, customer_id, office_location_id, payment_method_id,
            or_no, payment_type, receipt_type, payment_amount, applied_amount, unapplied_amount, memo, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Official Receipt', ?, ?, ?, ?, ?)`,
        [p.cp_pk, String(p.DateCreated_TransH).slice(0, 10), custByName.get(clean(p.Name_Cust).toLowerCase()) || null,
          locByName.get(clean(p.Name_Loc).toLowerCase()) || null, methodByName.get((p.PaymentMethod_TransH || '').toUpperCase()) || null,
          clean(p.ORNo_TransH) || null, clean(p.Type_TransH) || null, num(p.TotalAmount_TransH), num(p.AppliedPayments_TransH),
          num(p.UnappliedPayments_TransH), clean(p.Memo_TransH) || null, paymentStatus(p.Status_TransH)]);
      done += 1;
    }
    await conn.commit();
    console.log(`Committed: ${newCustomers.length} customer(s) created, ${done} payment(s) imported.`);
  } catch (e) { await conn.rollback(); console.error('FAILED (rolled back):', e.message); process.exitCode = 1; } finally { conn.release(); }
  await pool.end();
})();
