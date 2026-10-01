// Backfill the header details the payment migration dropped, from the source's Customer Payment
// list: Receipt type (CR / OR / PR -- every migrated payment was stamped "Official Receipt"),
// OR/CR or PR number, Payment Type, Reference #, Prepared By and Issued By. Mapping in
// lib/paymentHeader.js.
//
// Only MIGRATED payments are touched (created_by_user_id IS NULL): a payment entered in T1S keeps
// what its user typed. Receipt type is overwritten, since the stored one is the migration's
// default; every other field is filled only where it is still blank. Re-running is harmless.
//
//   node src/db/backfill-customer-payment-header.js [--from=2026-01-01] [--to=YYYY-MM-DD]          dry run
//   node src/db/backfill-customer-payment-header.js [--from=...] [--to=...] --apply
//
// Needs customer_payments.prepared_by_name / issued_by_name (add-customer-payment-people.js).
// Run against ONE box of the droplet/office pair; replication carries it to the other.
require('dotenv').config();
const pool = require('../db');
const L = require('./lib/liveWindow');
const { sourcePaymentHeader } = require('./lib/paymentHeader');

const APPLY = process.argv.includes('--apply');
const arg = (name, def) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || def;
const FROM = arg('from', '2026-01-01');
const TO = arg('to', new Date().toISOString().slice(0, 10));
const blank = (v) => v == null || String(v).trim() === '';

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN'}, ${FROM}..${TO}`);
  const [cols] = await pool.query("SHOW COLUMNS FROM customer_payments LIKE 'issued_by_name'");
  if (!cols.length) throw new Error('Run add-customer-payment-people.js first.');

  const [ours] = await pool.query(
    `SELECT id, customer_payment_no, receipt_type, or_no, payment_type, reference_no, prepared_by_name, issued_by_name
       FROM customer_payments
      WHERE created_by_user_id IS NULL AND date_created >= ? AND date_created < DATE_ADD(?, INTERVAL 1 DAY)`,
    [FROM, TO]);
  const byNo = new Map(ours.map((r) => [r.customer_payment_no, r]));
  console.log(`Migrated payments in window: ${byNo.size}`);

  const token = await L.login();
  const shift = (d, days) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10); };
  const rows = await L.fetchWindow(token, {
    endpoint: 'get_customer_payments', from: shift(FROM, -31), to: shift(TO, 31), keyField: 'cp_pk',
    onProgress: (m) => console.log(m),
  });

  const counts = { matched: 0, receipt_type: 0, or_no: 0, payment_type: 0, reference_no: 0, prepared_by_name: 0, issued_by_name: 0, rows: 0 };
  const updates = [];
  for (const p of rows) {
    const mine = byNo.get(p.cp_pk);
    if (!mine) continue;
    counts.matched += 1;
    const src = sourcePaymentHeader(p);
    const set = {};
    if (src.receipt_type && src.receipt_type !== mine.receipt_type) set.receipt_type = src.receipt_type;
    for (const f of ['or_no', 'payment_type', 'reference_no', 'prepared_by_name', 'issued_by_name']) {
      if (src[f] && blank(mine[f])) set[f] = src[f];
    }
    // A raw source type ("Full") stored by the old importer is replaced with its label.
    if (src.payment_type && !set.payment_type && mine.payment_type && mine.payment_type !== src.payment_type
      && mine.payment_type.toLowerCase() === String(p.Type_TransH || '').trim().toLowerCase()) {
      set.payment_type = src.payment_type;
    }
    const keys = Object.keys(set);
    if (!keys.length) continue;
    keys.forEach((k) => { counts[k] += 1; });
    counts.rows += 1;
    updates.push({ id: mine.id, set });
  }

  console.log(`\nMatched in source: ${counts.matched} of ${byNo.size} (the rest are not in the source -- e.g. CPAY- rows)`);
  console.log(`Payments to update: ${counts.rows}`);
  for (const f of ['receipt_type', 'or_no', 'payment_type', 'reference_no', 'prepared_by_name', 'issued_by_name']) {
    console.log(`  ${f.padEnd(17)} ${counts[f]}`);
  }
  if (!APPLY) { console.log('\nDRY RUN -- nothing written. Re-run with --apply.'); return; }

  let done = 0;
  for (const u of updates) {
    const keys = Object.keys(u.set);
    // Re-checks created_by_user_id, so a payment edited in T1S meanwhile is never overwritten.
    await pool.query(
      `UPDATE customer_payments SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND created_by_user_id IS NULL`,
      [...keys.map((k) => u.set[k]), u.id]);
    done += 1;
    if (done % 2000 === 0) console.log(`  ...${done}/${updates.length}`);
  }
  console.log(`\nUpdated ${done} payments.`);
}

main()
  .catch((e) => { console.error('ERR', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
