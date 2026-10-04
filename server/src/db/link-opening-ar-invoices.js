// Point each opening AR item at the invoice it names, now that the invoice exists.
//
// opening_ar_items carries the source system's own aging at the books start: one row per open
// document, with doc_no ("INV-1692") and a sales_invoice_id that is filled in only where T1S held
// that invoice when the opening balances were loaded. Rows whose invoice arrived later -- the
// 2017-2020 open invoices imported on 2026-10-04, say -- kept a NULL link, and two things follow
// from that:
//
//   1. AR Aging Details renders the row with no document to open. The report builds its link from
//      the id, so a null id made "/sales-invoices/null", which is the "it shows null" that sent me
//      looking. (The report itself is fixed separately, so a row that CANNOT have a link -- every
//      opening Unapplied Payment and Credit Memo -- stops pretending it has one.)
//   2. More importantly, the balance stops being netted. lib/openingBalances.js subtracts what
//      2026 payments and credit memos have settled against the LINKED invoice; with no link an
//      opening row shows the balance it had at the books start forever, even after the money came
//      in. The link is what keeps the aging from over-stating.
//
// Matched on doc_no alone, because that is what the source gives. Verified on the droplet before
// running: of 320 unlinked Invoice rows, 292 matched exactly one invoice, none matched two, and
// none matched an invoice belonging to a different customer -- so the match is not a guess. A row
// matching several invoices, or one whose invoice belongs to another customer, is reported and
// left alone.
//
// DRY RUN BY DEFAULT, and the dry run prints what the aging balance would change by.
//
//   node src/db/link-opening-ar-invoices.js [--apply]
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
// opening_ar_items and sales_invoices were created with different default collations, so the join
// has to say which one to compare in rather than letting MySQL refuse the mix.
const C = 'COLLATE utf8mb4_unicode_ci';
const JOIN = `si.invoice_no ${C} = o.doc_no ${C}`;

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : '   (DRY RUN -- nothing will be written)'}\n`);

  const [[before]] = await pool.query(
    "SELECT COUNT(*) n, SUM(sales_invoice_id IS NULL) unlinked FROM opening_ar_items WHERE doc_type = 'Invoice'");
  console.log(`Opening AR invoice rows: ${before.n}, of which ${before.unlinked} carry no link.`);

  // Ambiguous or cross-customer matches are never linked automatically.
  const [bad] = await pool.query(
    `SELECT o.id, o.doc_no, COUNT(*) matches
       FROM opening_ar_items o JOIN sales_invoices si ON ${JOIN}
      WHERE o.sales_invoice_id IS NULL AND o.doc_type = 'Invoice'
      GROUP BY o.id, o.doc_no HAVING COUNT(*) > 1`);
  const [cross] = await pool.query(
    `SELECT o.id, o.doc_no, o.customer_id AS opening_customer, si.customer_id AS invoice_customer
       FROM opening_ar_items o JOIN sales_invoices si ON ${JOIN}
      WHERE o.sales_invoice_id IS NULL AND o.doc_type = 'Invoice'
        AND si.customer_id IS NOT NULL AND si.customer_id <> o.customer_id`);
  for (const r of bad) console.log(`  ! ${r.doc_no}: ${r.matches} invoices carry that number -- left alone`);
  for (const r of cross) console.log(`  ! ${r.doc_no}: invoice belongs to customer ${r.invoice_customer}, opening row to ${r.opening_customer} -- left alone`);

  const skip = new Set([...bad.map((r) => r.id), ...cross.map((r) => r.id)]);
  const [matches] = await pool.query(
    `SELECT o.id, o.doc_no, o.balance, si.id AS invoice_id
       FROM opening_ar_items o JOIN sales_invoices si ON ${JOIN}
      WHERE o.sales_invoice_id IS NULL AND o.doc_type = 'Invoice'
      ORDER BY o.doc_no`);
  const todo = matches.filter((m) => !skip.has(m.id));
  console.log(`\nLinkable: ${todo.length}`);

  // What linking changes in the report: once linked, settlements made since the books start are
  // deducted from the opening balance. Anything already paid stops being aged.
  const ids = todo.map((t) => t.invoice_id);
  let willNet = 0; let nettedRows = 0;
  if (ids.length) {
    const [[books]] = await pool.query("SELECT MAX(as_of) AS as_of FROM opening_ar_items");
    const [settled] = await pool.query(
      `SELECT x.id, SUM(x.amt) amt FROM (
         SELECT cpl.sales_invoice_id id, cpl.applied_amount amt
           FROM customer_payment_lines cpl JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
          WHERE cpl.sales_invoice_id IN (?) AND cp.status != 'voided' AND cp.date_created > ?
         UNION ALL
         SELECT cma.sales_invoice_id, cma.applied_amount
           FROM credit_memo_applications cma JOIN credit_memos cm ON cm.id = cma.credit_memo_id
          WHERE cma.sales_invoice_id IN (?) AND cm.status != 'voided' AND cm.date_created > ?
       ) x GROUP BY x.id`, [ids, books.as_of, ids, books.as_of]);
    const by = new Map(settled.map((r) => [r.id, Number(r.amt) || 0]));
    for (const t of todo) {
      const amt = by.get(t.invoice_id) || 0;
      if (amt) { willNet += Math.min(amt, Number(t.balance)); nettedRows += 1; }
    }
  }
  console.log(`Of those, ${nettedRows} have been settled since the books start; linking removes ${willNet.toFixed(2)} from the aged balance.`);
  console.log(`The other ${todo.length - nettedRows} keep the balance they already show -- they just gain a working link.\n`);

  for (const t of todo.slice(0, 8)) console.log(`  ${t.doc_no} -> invoice #${t.invoice_id}`);
  if (todo.length > 8) console.log(`  ... and ${todo.length - 8} more`);

  if (!APPLY) { console.log('\nDRY RUN -- re-run with --apply to write.'); return; }

  let done = 0;
  for (const t of todo) {
    await pool.query('UPDATE opening_ar_items SET sales_invoice_id = ? WHERE id = ? AND sales_invoice_id IS NULL', [t.invoice_id, t.id]);
    done += 1;
  }
  const [[after]] = await pool.query(
    "SELECT SUM(sales_invoice_id IS NULL) unlinked FROM opening_ar_items WHERE doc_type = 'Invoice'");
  console.log(`\nLinked ${done}. Opening AR invoice rows still unlinked: ${after.unlinked} (no invoice of that number on file).`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
