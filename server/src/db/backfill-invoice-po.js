// Backfill sales_invoices.po_no from the SOURCE invoice.
//
// The migration never carried the customer's PO number over -- 10,630 of 10,658 2026 invoices
// came in blank. The source's invoice LIST has no PO column, so each invoice's detail is read
// (get_invoice): its own invc_po, else the PO on its Sales Order (so_po), else on its estimate
// (sl_po). About one invoice in five has one.
//
// Only rows whose po_no is still blank are touched, so a PO typed in this system always wins and
// re-running continues where it stopped.
//
//   node src/db/backfill-invoice-po.js [--from=2026-01-01] [--to=2026-12-31]           dry run
//   node src/db/backfill-invoice-po.js [--from=...] [--to=...] --apply
//
// Run it against ONE box of the droplet/office pair; replication carries it to the other.
require('dotenv').config();
const pool = require('../db');
const L = require('./lib/liveWindow');

const APPLY = process.argv.includes('--apply');
const arg = (name, def) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || def;
const FROM = arg('from', '2026-01-01');
const TO = arg('to', new Date().toISOString().slice(0, 10));
const CONCURRENCY = 4;
const clean = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN'}, ${FROM}..${TO}`);
  const [blank] = await pool.query(
    `SELECT id, invoice_no FROM sales_invoices
      WHERE COALESCE(po_no, '') = '' AND date_created >= ? AND date_created < DATE_ADD(?, INTERVAL 1 DAY)`,
    [FROM, TO]);
  const idByNo = new Map(blank.map((r) => [r.invoice_no, r.id]));
  console.log(`Invoices with no PO #: ${idByNo.size}`);
  if (!idByNo.size) return;

  const token = await L.login();
  // A month either side: our invoice dates can sit days off the source's.
  const shift = (d, days) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10); };
  const rows = await L.fetchWindow(token, {
    endpoint: 'get_invoices', from: shift(FROM, -31), to: shift(TO, 31), keyField: 'invc_pk',
    onProgress: (m) => console.log(m),
  });
  const todo = rows.filter((r) => idByNo.has(r.invc_pk));
  console.log(`Found in source: ${todo.length} of ${idByNo.size}`);

  let withPo = 0, written = 0, failed = 0, done = 0;
  const examples = [];
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < todo.length) {
      const r = todo[i++];
      try {
        const h = (await L.api(token, 'get_invoice', { pk: r.SysPK_TransH })).data?.[0] || {};
        const po = clean(h.invc_po || h.so_po || h.sl_po).slice(0, 60);
        if (po) {
          withPo += 1;
          if (examples.length < 8) examples.push(`${r.invc_pk} -> ${po}`);
          if (APPLY) {
            const [res] = await pool.query(
              "UPDATE sales_invoices SET po_no = ? WHERE id = ? AND COALESCE(po_no, '') = ''", [po, idByNo.get(r.invc_pk)]);
            written += res.affectedRows;
          }
        }
      } catch (e) {
        failed += 1;
      }
      done += 1;
      if (done % 500 === 0) console.log(`  ...${done}/${todo.length}, with PO ${withPo}, failed ${failed}`);
    }
  }));

  console.log(`\nChecked ${todo.length}: ${withPo} have a PO # in the source, ${failed} fetches failed.`);
  console.log(examples.map((e) => `  ${e}`).join('\n'));
  console.log(APPLY ? `Updated ${written} invoices.` : 'DRY RUN -- nothing written. Re-run with --apply.');
}

main()
  .catch((e) => { console.error('ERR', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
