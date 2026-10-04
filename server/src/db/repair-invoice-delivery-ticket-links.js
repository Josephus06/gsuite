// Re-point invoices whose delivery_ticket_id names a row that no longer exists.
//
// import-delivery-tickets.js REPLACES a ticket it already holds -- deletes the row and inserts a
// fresh one, which hands it a new id. Any invoice already pointing at the old id is then left
// referring to nothing: the Delivery Ticket link on the invoice goes dead, and so does anything
// that reads the invoice through it. (The importer's new --only/--only-file flags stop a
// gap-filling run from replacing tickets it was not asked for, which is what let this happen at
// scale; this repairs what earlier runs left behind.)
//
// The ticket itself is still there under the same NUMBER, so the repair is to look the invoice up
// in the source, read the DT number it was raised from, and point the invoice at the local ticket
// carrying that number. An invoice whose source row is not in the cached window, or whose ticket
// number is not on file, is reported and left exactly as it is.
//
// DRY RUN BY DEFAULT. Pass --apply to write.
//
//   node src/db/repair-invoice-delivery-ticket-links.js [--apply] [--cache=<get_invoices file>]
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const pool = require('../db');
const L = require('./lib/liveWindow');

const APPLY = process.argv.includes('--apply');
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;

// EVERY cached get_invoices window, merged. Picking one file was wrong: the cache holds a dozen
// windows of different widths, and the newest-NAMED of them is usually a narrow recent one that
// knows nothing about an invoice raised in August. Merging costs a few MB of JSON and means the
// repair sees every invoice any run has ever fetched.
function loadSource() {
  const named = arg('cache', null);
  const files = named ? [named]
    : fs.readdirSync(L.CACHE_DIR).filter((f) => f.startsWith('get_invoices_')).map((f) => path.join(L.CACHE_DIR, f));
  if (!files.length) throw new Error(`No cached get_invoices window in ${L.CACHE_DIR}. Run report-missing-invoices.js first.`);
  const map = new Map();
  for (const f of files) {
    for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      const k = String(r.invc_pk || '').trim().toUpperCase();
      if (k && !map.has(k)) map.set(k, r);
    }
  }
  console.log(`Source parents read from ${files.length} cached window(s): ${map.size} invoice(s)`);
  return map;
}

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : '   (DRY RUN -- nothing will be written)'}`);

  const [bad] = await pool.query(
    `SELECT si.id, si.invoice_no, si.delivery_ticket_id
       FROM sales_invoices si
       LEFT JOIN delivery_tickets dt ON dt.id = si.delivery_ticket_id
      WHERE si.delivery_ticket_id IS NOT NULL AND dt.id IS NULL
      ORDER BY si.id`);
  console.log(`Invoices pointing at a delivery ticket that no longer exists: ${bad.length}`);
  if (!bad.length) { console.log('Nothing to repair.'); return; }

  const src = loadSource();

  let fixed = 0; let unknown = 0; let noTicket = 0;
  for (const inv of bad) {
    const row = src.get(String(inv.invoice_no).trim().toUpperCase());
    const parent = row && row.sl_pk ? String(row.sl_pk).trim() : null;
    if (!parent) { console.log(`  ${inv.invoice_no}: not in the cached source window -- left alone`); unknown += 1; continue; }
    const [[dt]] = await pool.query('SELECT id FROM delivery_tickets WHERE dt_no = ?', [parent]);
    if (!dt) { console.log(`  ${inv.invoice_no}: source parent ${parent} is not on file -- left alone`); noTicket += 1; continue; }
    console.log(`  ${inv.invoice_no}: ${inv.delivery_ticket_id} (gone) -> ${dt.id} (${parent})`);
    if (APPLY) await pool.query('UPDATE sales_invoices SET delivery_ticket_id = ? WHERE id = ?', [dt.id, inv.id]);
    fixed += 1;
  }

  console.log(`\n${APPLY ? 'Repaired' : 'Would repair'} ${fixed}; left alone ${unknown + noTicket} (${unknown} not in the source window, ${noTicket} ticket not on file).`);
  if (APPLY) {
    const [[{ n }]] = await pool.query(
      `SELECT COUNT(*) n FROM sales_invoices si
         LEFT JOIN delivery_tickets dt ON dt.id = si.delivery_ticket_id
        WHERE si.delivery_ticket_id IS NOT NULL AND dt.id IS NULL`);
    console.log(`Still dangling after the repair: ${n}`);
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
