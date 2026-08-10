// Surveys what a date window actually contains on live, before committing to a migration run.
// Pulls (and caches, via lib/liveWindow) every list endpoint the importers use, then reports
// volumes, the VOID/CANCELLED share that will be excluded, duplicate document numbers, and
// which sales reps have no matching local employee (their orders would otherwise be skipped).
//
//   node src/db/survey-live-window.js --from=2021-01-01 --to=2021-12-31
//   node src/db/survey-live-window.js --from=2021-01-01 --to=2021-12-31 --refresh
const pool = require('../db');
require('dotenv').config();
const { login, fetchWindow, isVoidOrCancelled } = require('./lib/liveWindow');

const argVal = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const FROM = argVal('from', '2021-01-01');
const TO = argVal('to', '2021-12-31');
const REFRESH = process.argv.includes('--refresh');
const log = (s) => console.log(s);
const repNorm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();

const SOURCES = [
  { endpoint: 'get_sales_orders', keyField: 'so_upk', extra: { viewAll: true }, label: 'Sales Orders' },
  { endpoint: 'get_invoices', keyField: 'invc_pk', label: 'Invoices' },
  { endpoint: 'get_delivery_tickets', keyField: 'dt_pk', label: 'Delivery Tickets' },
  { endpoint: 'get_customer_payments', keyField: 'cp_pk', label: 'Customer Payments' },
  { endpoint: 'get_purchase_orders', keyField: 'UserPK_TransH', extra: { viewAll: true }, label: 'Purchase Orders' },
];

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Surveying live window ${FROM}..${TO}${REFRESH ? ' (refreshing cache)' : ''}\n`);
  const token = await login();

  const results = {};
  for (const s of SOURCES) {
    console.log(`${s.label}:`);
    const rows = await fetchWindow(token, { ...s, from: FROM, to: TO, refresh: REFRESH, onProgress: log });
    results[s.endpoint] = rows;

    const live = rows.filter((r) => !isVoidOrCancelled(r.Status_TransH));
    const dead = rows.length - live.length;
    const byStatus = {};
    for (const r of rows) { const k = (r.Status_TransH || '(none)').toUpperCase(); byStatus[k] = (byStatus[k] || 0) + 1; }
    // Duplicate document numbers within the window (fetchWindow already dropped exact repeats,
    // so anything here would be a genuine live-side collision).
    const counts = new Map();
    for (const r of rows) counts.set(r[s.keyField], (counts.get(r[s.keyField]) || 0) + 1);
    const dupes = [...counts.entries()].filter(([, c]) => c > 1);

    console.log(`  total ${rows.length} | migratable ${live.length} | void/cancelled ${dead} | duplicate numbers ${dupes.length}`);
    console.log(`  by status: ${Object.entries(byStatus).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    if (dupes.length) console.log(`  DUPLICATES: ${dupes.slice(0, 10).map(([k, c]) => `${k}x${c}`).join(', ')}`);
    console.log('');
  }

  // Sales reps in the window vs local employees -- an unmatched rep means skipped sales orders.
  const sos = results.get_sales_orders.filter((r) => !isVoidOrCancelled(r.Status_TransH));
  const repCounts = new Map();
  for (const so of sos) repCounts.set(repNorm(so.Name_Empl), (repCounts.get(repNorm(so.Name_Empl)) || 0) + 1);
  const [emps] = await pool.query("SELECT id, LOWER(CONCAT(first_name,' ',last_name)) nm FROM employees");
  const empByName = new Map(emps.map((e) => [repNorm(e.nm), e.id]));
  const missing = [...repCounts.entries()].filter(([n]) => !empByName.has(n)).sort((a, b) => b[1] - a[1]);
  console.log(`Sales reps in window: ${repCounts.size}; without a local employee: ${missing.length}`);
  if (missing.length) {
    console.log(`  ${missing.map(([n, c]) => `${n} (${c} SOs)`).join('\n  ')}`);
    console.log(`  -> ${missing.reduce((a, [, c]) => a + c, 0)} sales order(s) would be skipped.`);
  }

  // Departments/divisions referenced.
  const depts = new Set(sos.map((s) => (s.Name_Dept || '').trim()).filter(Boolean));
  console.log(`\nDepartments in window: ${[...depts].join(', ')}`);

  // Customers -- how many already exist locally (drives customer-payment scoping).
  const custNames = new Set(results.get_customer_payments.map((p) => (p.Name_Cust || '').trim().toLowerCase()).filter(Boolean));
  const [custs] = await pool.query('SELECT LOWER(name) nm FROM customers');
  const haveCust = new Set(custs.map((c) => c.nm));
  const missingCust = [...custNames].filter((n) => !haveCust.has(n));
  console.log(`Payment customers: ${custNames.size}; not yet local: ${missingCust.length} (they arrive with the sales import).`);

  // What is already migrated locally for this window.
  const [[soLocal]] = await pool.query('SELECT COUNT(*) c FROM sales_orders WHERE date_created BETWEEN ? AND ?', [FROM, TO]);
  const [[poLocal]] = await pool.query('SELECT COUNT(*) c FROM purchase_orders WHERE date_created BETWEEN ? AND ?', [FROM, TO]);
  console.log(`\nAlready local in window: ${soLocal.c} sales order(s), ${poLocal.c} purchase order(s).`);
  await pool.end();
}
main().catch((e) => { console.error('Survey failed:', e.message); process.exit(1); });
