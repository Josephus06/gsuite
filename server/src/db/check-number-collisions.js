// Pre-flight check for a migration window: does any live document number already exist
// locally on a DIFFERENT record?
//
// This matters because the importers are idempotent *by document number* -- an existing row
// with the same number is treated as "already imported" and the live document is skipped. That
// is exactly right when the local row IS the migrated document, but wrong when it is an
// unrelated record the app created itself under its own numbering (those carry no live pk /
// no live provenance). Left unchecked the live document is silently dropped.
//
// Run this before migrate-year.js. It reports, per document type:
//   - collisions with locally-authored records  -> the live document WILL be skipped
//   - matches against already-migrated records  -> normal, the re-run just refreshes them
//
//   node src/db/check-number-collisions.js --from=2021-01-01 --to=2021-12-31
const pool = require('../db');
require('dotenv').config();
const { login, fetchWindow, isVoidOrCancelled } = require('./lib/liveWindow');

const argVal = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const FROM = argVal('from', '2021-01-01');
const TO = argVal('to', '2021-12-31');
const log = (s) => console.log(s);

// Each doc type: where the number lives locally, and how to tell a migrated row from an
// app-authored one (`nativeTest` is SQL that is true for rows this app created itself).
const DOCS = [
  { label: 'Sales Order', endpoint: 'get_sales_orders', keyField: 'so_upk', extra: { viewAll: true },
    table: 'sales_orders', col: 'sales_order_no', dateCol: 'date_created' },
  { label: 'Estimate', endpoint: 'get_sales_orders', keyField: 'sl_upk', extra: { viewAll: true },
    table: 'estimates', col: 'estimate_no', dateCol: 'date_created' },
  { label: 'Invoice', endpoint: 'get_invoices', keyField: 'invc_pk',
    table: 'sales_invoices', col: 'invoice_no', dateCol: 'date_created' },
  { label: 'Delivery Ticket', endpoint: 'get_delivery_tickets', keyField: 'dt_pk',
    table: 'delivery_tickets', col: 'dt_no', dateCol: 'date_created' },
  { label: 'Customer Payment', endpoint: 'get_customer_payments', keyField: 'cp_pk',
    table: 'customer_payments', col: 'customer_payment_no', dateCol: 'date_created' },
  { label: 'Purchase Order', endpoint: 'get_purchase_orders', keyField: 'UserPK_TransH', extra: { viewAll: true },
    table: 'purchase_orders', col: 'po_no', dateCol: 'date_created', nativeTest: 'live_pk IS NULL' },
];

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Checking live ${FROM}..${TO} document numbers against local records\n`);
  const token = await login();
  let totalBlocking = 0;

  for (const d of DOCS) {
    const rows = await fetchWindow(token, { ...d, from: FROM, to: TO, onProgress: () => {} });
    // Live numbers we would actually try to migrate.
    const wanted = new Set();
    for (const r of rows) {
      if (isVoidOrCancelled(r.Status_TransH)) continue;
      const k = r[d.keyField];
      if (k) wanted.add(k);
    }
    if (!wanted.size) { console.log(`${d.label}: no live documents in window.\n`); continue; }

    const [local] = await pool.query(
      `SELECT ${d.col} AS no, ${d.dateCol} AS dt${d.nativeTest ? `, (${d.nativeTest}) AS is_native` : ''}
         FROM ${d.table} WHERE ${d.col} IN (?)`, [[...wanted]]);

    // A local row dated inside the window is the migrated document (a re-run refreshes it);
    // one dated outside it is a different record that happens to share the number.
    const inWindow = [];
    const outOfWindow = [];
    for (const r of local) {
      const dt = r.dt ? String(r.dt).slice(0, 10) : '';
      const native = d.nativeTest ? !!Number(r.is_native) : false;
      (dt >= FROM && dt <= TO && !native ? inWindow : outOfWindow).push(`${r.no}@${dt}${native ? ' [app-created]' : ''}`);
    }
    console.log(`${d.label}: ${wanted.size} live number(s) in window; ${local.length} already exist locally.`);
    console.log(`  already migrated for this window (re-run refreshes): ${inWindow.length}`);
    if (outOfWindow.length) {
      totalBlocking += outOfWindow.length;
      console.log(`  !! COLLISION with unrelated local records -- these live documents WILL BE SKIPPED: ${outOfWindow.length}`);
      console.log(`     ${outOfWindow.slice(0, 25).join(', ')}${outOfWindow.length > 25 ? ', ...' : ''}`);
    }
    console.log('');
  }

  console.log(totalBlocking
    ? `${totalBlocking} live document(s) collide with unrelated local records and will not migrate.\n` +
      'Renumber or remove those local records first if the live documents are the ones you want.'
    : 'No collisions: every live number is either free or belongs to the already-migrated document.');
  await pool.end();
}
main().catch((e) => { console.error('Check failed:', e.message); process.exit(1); });
