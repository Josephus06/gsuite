// One-off import: pulls the REAL customer payment headers (PAY-####) from the live system
// into the Customer Payments module, standalone.
//
// WHY standalone (no invoice lines): the live API exposes get_customer_payments (payment
// headers -- real number, date, amount, method, OR #, status, customer) but NO endpoint
// that returns which invoices a payment settled. So these carry the genuine payment record
// but are NOT applied to invoices. (The reconstructed CPAY-INV-#### payments from
// generate-invoice-payments.js are the ones that link to invoices; these coexist under
// their real PAY-#### numbers and are easy to tell apart.)
//
// Scoped to the payments dated in the window whose customer already exists locally (the
// customers imported with the 4 reps' sales). Idempotent: re-running replaces a payment
// matched by its number.
//
// VOIDED payments are skipped outright rather than imported with status 'voided'.
//
//   node src/db/import-customer-payments.js --from=2026-01-01 --to=2026-07-31 --dry-run
//   node src/db/import-customer-payments.js --from=2026-01-01 --to=2026-07-31
const pool = require('../db');
require('dotenv').config();
const { fetchWindow, isVoidOrCancelled } = require('./lib/liveWindow');

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const REFRESH = process.argv.includes('--refresh');
function argVal(name, def) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
}
const FROM = argVal('from', '2026-01-01');
const TO = argVal('to', '2026-07-31');
const day = (v) => (v || '').toString().slice(0, 10);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clean = (s) => (s || '').toString().trim().replace(/\s+/g, ' ');

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  const b = await r.json();
  if (!b?.data?.token) throw new Error(`Login failed: ${b?.message}`);
  return b.data.token;
}
// Paging + retries now live in lib/liveWindow.js (fetchWindow); this script only needs login.

// Only import payments for customers we already have locally (the imported sales customers).
const customerCache = new Map();
async function localCustomerId(name) {
  const key = clean(name).toLowerCase();
  if (!key) return null;
  if (customerCache.has(key)) return customerCache.get(key);
  const [[row]] = await pool.query('SELECT id FROM customers WHERE LOWER(name) = ? LIMIT 1', [key]);
  const id = row ? row.id : null;
  customerCache.set(key, id);
  return id;
}

function paymentStatus(live) {
  const s = (live || '').toUpperCase();
  if (s.includes('VOID') || s.includes('CANCEL')) return 'voided';
  if (s.includes('DEPOSITED') && !s.includes('NOT')) return 'deposited';
  return 'not_deposited';
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing written.\n' : 'APPLYING to local.\n');

  const token = await login();
  const [methods] = await pool.query('SELECT id, name FROM payment_methods');
  const methodByName = new Map(methods.map((m) => [m.name.toUpperCase(), m.id]));
  const [locations] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locations.map((l) => [clean(l.location_name).toLowerCase(), l.id]));

  // Pull the window's payments (binary-searched + cached on disk).
  const rows = await fetchWindow(token, {
    endpoint: 'get_customer_payments', from: FROM, to: TO, keyField: 'cp_pk',
    refresh: REFRESH, onProgress: (m) => console.log(m),
  });
  const payments = [];
  const seenNo = new Set();
  let scanned = 0, skippedNoCustomer = 0, voidSkipped = 0;
  for (const p of rows) {
    if (isVoidOrCancelled(p.Status_TransH)) { voidSkipped += 1; continue; }
    if (!p.cp_pk || seenNo.has(p.cp_pk)) continue; // one local payment per number
    seenNo.add(p.cp_pk);
    scanned += 1;
    const custId = await localCustomerId(p.Name_Cust);
    if (!custId) { skippedNoCustomer += 1; continue; }
    payments.push({ ...p, _customerId: custId });
  }
  console.log(`In ${FROM}..${TO}: ${scanned} live payment(s) (${voidSkipped} void/cancelled skipped), ` +
    `${payments.length} for local customers (${skippedNoCustomer} skipped -- customer not imported).`);

  if (DRY_RUN) {
    const total = payments.reduce((s, p) => s + num(p.TotalAmount_TransH), 0);
    console.log(`Would import ${payments.length} standalone customer payment(s) totalling ${total.toFixed(2)}.`);
    console.log('\nDRY RUN -- nothing written.');
    await pool.end();
    return;
  }

  let created = 0, replaced = 0;
  for (const p of payments) {
    const no = p.cp_pk;
    if (!no) continue;
    const methodId = methodByName.get((p.PaymentMethod_TransH || '').toUpperCase()) || null;
    const locId = locByName.get(clean(p.Name_Loc).toLowerCase()) || null;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[existing]] = await conn.query('SELECT id FROM customer_payments WHERE customer_payment_no = ?', [no]);
      if (existing) {
        await conn.query('DELETE FROM customer_payment_lines WHERE customer_payment_id = ?', [existing.id]);
        await conn.query('DELETE FROM customer_payments WHERE id = ?', [existing.id]);
        replaced += 1;
      } else created += 1;
      await conn.query(
        `INSERT INTO customer_payments
           (customer_payment_no, date_created, customer_id, office_location_id, payment_method_id,
            or_no, payment_type, receipt_type, payment_amount, applied_amount, unapplied_amount, memo, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Official Receipt', ?, ?, ?, ?, ?)`,
        [no, p.DateCreated_TransH, p._customerId, locId, methodId, clean(p.ORNo_TransH),
          clean(p.Type_TransH), num(p.TotalAmount_TransH), num(p.AppliedPayments_TransH),
          num(p.UnappliedPayments_TransH), clean(p.Memo_TransH) || null, paymentStatus(p.Status_TransH)]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      console.warn(`!! ${no} failed: ${err.message}`);
    } finally {
      conn.release();
    }
  }

  console.log(`\nImported ${created + replaced} standalone payment(s) (${created} new, ${replaced} replaced).`);
  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
