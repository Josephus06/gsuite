// Links invoices raised off an Estimate to the Sales Order that Estimate became.
//
// An invoice billed through the Estimate path was written with sales_order_id NULL, always --
// see billEstimate in routes/salesInvoices.js, which hard-coded the NULL on the reading that an
// estimate-sourced invoice has no order behind it. That is true only until the estimate reaches
// `approved`, which is the act that GENERATES the Sales Order, and an estimate is billable from
// `pending_customer_approval` onward. So an estimate can be invoiced and then converted, or
// converted and then invoiced, and either way the invoice never named the order.
//
// The cost of that: the order's Related Records tab reads sales_invoices.sales_order_id, so those
// invoices are invisible from the order they belong to, permanently -- nothing else ever revisits
// that column.
//
// LINKING IS NOT THE SAME AS LISTING. The tab holds an estimate-sourced invoice back until every
// job order behind it is finished (routes/salesInvoices.js, the by-sales-order route), so a row
// linked here does not necessarily appear today. What linking does is make it able to appear at
// all: unlinked, it stays off that order for good no matter how far the work gets.
//
// WHAT THIS DOES AND DOES NOT TOUCH. It writes one column on invoices that have none. It does not
// touch job_orders.quantity_invoiced, the order's status, or any GL posting -- the estimate path
// never moved those, and moving them now would credit orders for billing that never debited them.
// The invoice becomes visible from the order, not counted by it.
//
// Only rows where sales_order_id IS NULL are considered, so an invoice that already names an
// order can never be moved onto a different one.
//
// IDEMPOTENT: safe to re-run -- a second run finds nothing left to link.
//
//   node src/db/backfill-estimate-invoice-sales-order.js
//   node src/db/backfill-estimate-invoice-sales-order.js --dry-run
require('dotenv').config();
const pool = require('../db');

const dryRun = process.argv.includes('--dry-run');

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${dryRun ? '  (DRY RUN)' : ''}\n`);

  // Reported before anything is written, so the dry run and the real run print the same list.
  // Every figure here is read rather than assumed -- this is the one chance to see the rows
  // before they change.
  const [rows] = await pool.query(
    `SELECT si.id, si.invoice_no, si.date_created, si.gross_amount, si.status,
            e.estimate_no, e.status AS estimate_status, so.id AS sales_order_id, so.sales_order_no
       FROM sales_invoices si
       JOIN estimates e ON e.id = si.estimate_id
       JOIN sales_orders so ON so.id = e.sales_order_id
      WHERE si.sales_order_id IS NULL
      ORDER BY si.id`
  );

  if (!rows.length) {
    console.log('Nothing to link: every estimate-sourced invoice whose estimate has a Sales Order');
    console.log('already names it.');
  } else {
    console.log(`${rows.length} invoice(s) to link:\n`);
    for (const r of rows) {
      console.log(`  ${r.invoice_no}  ${String(r.date_created).slice(0, 10)}  ${Number(r.gross_amount).toFixed(2)}`
        + `  ${r.status}  ${r.estimate_no} (${r.estimate_status})  ->  ${r.sales_order_no}`);
    }

    if (dryRun) {
      console.log('\nDry run -- nothing written.');
    } else {
      // One statement per row rather than one joined UPDATE: the set is tiny, and this way the
      // script cannot write a row it did not just print.
      for (const r of rows) {
        await pool.query('UPDATE sales_invoices SET sales_order_id = ? WHERE id = ? AND sales_order_id IS NULL',
          [r.sales_order_id, r.id]);
      }
      console.log(`\n${rows.length} invoice(s) linked.`);
    }
  }

  // Cancelled estimates are included above on purpose -- a cancelled ESTIMATE can still have left
  // a real invoice behind it, and that invoice still belongs on its order. What stays unlinked is
  // only what genuinely has no order yet.
  const [[left]] = await pool.query(
    `SELECT COUNT(*) AS n FROM sales_invoices si
       JOIN estimates e ON e.id = si.estimate_id
      WHERE si.sales_order_id IS NULL AND e.sales_order_id IS NULL`
  );
  console.log(`\n${left.n} estimate-sourced invoice(s) still unlinked, correctly: their estimate has`);
  console.log('no Sales Order yet. Converting it later links them -- routes/estimates.js does that now.');

  await pool.end();
}

main().catch(async (err) => { console.error('Failed:', err.message); await pool.end(); process.exit(1); });
