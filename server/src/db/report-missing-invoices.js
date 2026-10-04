// READ-ONLY. Which of the source's invoices T1S does not hold, and what each one hangs off.
//
// "Import all invoices" needs a list before it needs a run: the source's invoice table is the
// whole company's billing history, T1S already holds 76,000+ of it, and the only rows worth
// fetching in detail are the ones actually missing. This pages get_invoices over a window,
// drops the void and cancelled (never migrated -- import-sales.js's own rule), and compares
// invc_pk against sales_invoices.invoice_no.
//
// Each missing invoice is then sorted by what it can be attached to, which is what decides
// whether it can be imported at all:
//
//   so        the source raised it from a Sales Order T1S holds        -> importable
//   so-gap    from a Sales Order T1S does NOT hold                     -> needs the order first
//   nsso      from a Non-Standard Sales Order T1S holds                -> importable
//   nsso-gap  from an NSSO T1S does not hold                           -> needs the NSSO first
//   loose     raised from nothing at all (monthly rent and the like)   -> importable standalone
//
// --out=<file> writes the importable numbers one per line, which is exactly what
// import-invoices-by-number.js --file= reads.
//
//   node src/db/report-missing-invoices.js [--from=2021-01-01] [--to=<today>] [--out=missing.txt]
//                                          [--refresh] [--by-month]
//
// The source fetch is cached under server/.live-cache/, so a second run costs nothing.
const fs = require('fs');
require('dotenv').config();
const pool = require('../db');
const L = require('./lib/liveWindow');

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // PH date
const FROM = arg('from', '2021-01-01');
const TO = arg('to', today);
const OUT = arg('out', null);
const REFRESH = process.argv.includes('--refresh');
const BY_MONTH = process.argv.includes('--by-month');

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Source invoices ${FROM}..${TO}\n`);

  const token = await L.login();
  const rows = await L.fetchWindow(token, {
    endpoint: 'get_invoices', from: FROM, to: TO, keyField: 'invc_pk',
    refresh: REFRESH, onProgress: (m) => console.log(m),
  });

  const live = [];
  let dead = 0;
  for (const r of rows) {
    if (L.isVoidOrCancelled(r.Status_TransH)) { dead += 1; continue; }
    if (!r.invc_pk) continue;
    live.push(r);
  }
  console.log(`\nSource: ${rows.length} invoice(s) in window, ${dead} void/cancelled skipped, ${live.length} live.`);

  const [[{ n: held }]] = await pool.query('SELECT COUNT(*) n FROM sales_invoices');
  const [mine] = await pool.query('SELECT invoice_no FROM sales_invoices');
  const have = new Set(mine.map((r) => String(r.invoice_no).trim().toUpperCase()));
  console.log(`T1S: ${held} invoice(s) on file.`);

  const missing = live.filter((r) => !have.has(String(r.invc_pk).trim().toUpperCase()));
  console.log(`\nMISSING: ${missing.length}\n`);
  if (!missing.length) { console.log('Nothing to import -- T1S holds every live invoice in the window.'); return; }

  // What each missing invoice hangs off, and whether T1S holds that parent.
  const soNos = [...new Set(missing.map((r) => r.sl_pk).filter(Boolean))];
  const haveSo = new Set();
  const haveNsso = new Set();
  for (let i = 0; i < soNos.length; i += 500) {
    const chunk = soNos.slice(i, i + 500);
    const [so] = await pool.query('SELECT sales_order_no FROM sales_orders WHERE sales_order_no IN (?)', [chunk]);
    for (const r of so) haveSo.add(String(r.sales_order_no).trim().toUpperCase());
    const [ns] = await pool.query('SELECT nsso_no FROM non_standard_sales_orders WHERE nsso_no IN (?)', [chunk]);
    for (const r of ns) haveNsso.add(String(r.nsso_no).trim().toUpperCase());
  }

  const bucket = { so: [], 'so-gap': [], nsso: [], 'nsso-gap': [], loose: [] };
  for (const r of missing) {
    const parent = r.sl_pk ? String(r.sl_pk).trim().toUpperCase() : null;
    if (!parent) bucket.loose.push(r);
    else if (haveSo.has(parent)) bucket.so.push(r);
    else if (haveNsso.has(parent)) bucket.nsso.push(r);
    else if (parent.startsWith('NSSO')) bucket['nsso-gap'].push(r);
    else bucket['so-gap'].push(r);
  }
  for (const [k, v] of Object.entries(bucket)) {
    if (v.length) console.log(`  ${k.padEnd(9)} ${String(v.length).padStart(6)}   e.g. ${v.slice(0, 3).map((r) => `${r.invc_pk}${r.sl_pk ? ` <- ${r.sl_pk}` : ''}`).join(', ')}`);
  }

  const byYear = {};
  for (const r of missing) {
    const k = BY_MONTH ? L.day(r.DateCreated_TransH).slice(0, 7) : L.day(r.DateCreated_TransH).slice(0, 4);
    byYear[k] = (byYear[k] || 0) + 1;
  }
  console.log(`\nmissing by ${BY_MONTH ? 'month' : 'year'}:`);
  for (const k of Object.keys(byYear).sort()) console.log(`  ${k}  ${byYear[k]}`);

  const importable = [...bucket.so, ...bucket.nsso, ...bucket.loose];
  console.log(`\nImportable now (parent on file, or standalone): ${importable.length}`);
  console.log(`Blocked on a missing parent order:               ${bucket['so-gap'].length + bucket['nsso-gap'].length}`);
  if (OUT) {
    fs.writeFileSync(OUT, importable.map((r) => r.invc_pk).join('\n') + '\n');
    console.log(`\n${importable.length} number(s) -> ${OUT}   (feed it to import-invoices-by-number.js --file=)`);
    if (bucket['so-gap'].length + bucket['nsso-gap'].length) {
      const blocked = `${OUT}.blocked`;
      fs.writeFileSync(blocked, [...bucket['so-gap'], ...bucket['nsso-gap']].map((r) => `${r.invc_pk}\t${r.sl_pk}\t${L.day(r.DateCreated_TransH)}`).join('\n') + '\n');
      console.log(`${bucket['so-gap'].length + bucket['nsso-gap'].length} blocked (invoice, parent, date) -> ${blocked}`);
    }
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
