// Invoices that reached T1S with NO customer at all -- no sales order, estimate or NSSO behind them
// and sales_invoices.customer_id blank. Every screen that finds an invoice's customer through
// COALESCE(so, estimate, nsso, si.customer_id) drops them: Collection Forecast did not list
// INV-81354 (PLANTATION BAY, 40,320.00) although AR Aging Details did. AR Aging only shows them
// because it reads the source's opening balance (opening_ar_items), which carries the customer.
//
// 2026-10-02: 22 open invoices, 347,566.10, 6 customers -- every one of them in opening_ar_items
// with a customer, none claimed by two. This copies that customer onto sales_invoices.customer_id.
// Only fills a blank: an invoice with any customer link is never touched. Re-runnable.
//
//   node src/db/backfill-invoice-customer-from-opening.js            # preview
//   node src/db/backfill-invoice-customer-from-opening.js --apply    # backs up to /root/match2026/
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [rows] = await pool.query(
    `SELECT si.id, si.invoice_no, si.amount_due, si.customer_id AS old_customer_id,
            MIN(o.customer_id) AS customer_id, COUNT(DISTINCT o.customer_id) AS claims, c.name AS customer_name
       FROM sales_invoices si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
       JOIN opening_ar_items o ON o.sales_invoice_id = si.id AND o.customer_id IS NOT NULL
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE si.customer_id IS NULL AND so.customer_id IS NULL AND e.customer_id IS NULL AND ns.customer_id IS NULL
      GROUP BY si.id, si.invoice_no, si.amount_due, si.customer_id, c.name`,
  );
  const ambiguous = rows.filter((r) => Number(r.claims) > 1);
  const fill = rows.filter((r) => Number(r.claims) === 1);
  console.log(`Invoices with no customer but one in the opening balance: ${fill.length}` +
    ` (open ${fill.filter((r) => Number(r.amount_due) > 0).length}, due ${fill.reduce((s, r) => s + Number(r.amount_due), 0).toFixed(2)})`);
  if (ambiguous.length) console.log(`Skipped, opening balance names more than one customer: ${ambiguous.map((r) => r.invoice_no).join(', ')}`);
  console.table(fill.map((r) => ({ invoice: r.invoice_no, amount_due: Number(r.amount_due), customer: r.customer_name })));
  if (!APPLY || !fill.length) { await pool.end(); return; }

  const dir = '/root/match2026';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const backup = `${dir}/invoice-customer-backfill-${Date.now()}.json`;
  fs.writeFileSync(backup, JSON.stringify(fill.map((r) => ({ id: r.id, invoice_no: r.invoice_no, customer_id: r.old_customer_id })), null, 1));
  console.log(`Backup (customer_id before): ${backup}`);

  let n = 0;
  for (const r of fill) {
    const [res] = await pool.query('UPDATE sales_invoices SET customer_id = ? WHERE id = ? AND customer_id IS NULL', [r.customer_id, r.id]);
    n += res.affectedRows;
  }
  console.log(`Customer filled in on ${n} invoices.`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
