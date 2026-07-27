// The sales import never copied the sales division ("Department") onto sales_invoices or
// customer_payments, so those show Department = "" even though their sales order carries it.
// Backfill both from the owning sales order's sales_division_id. Idempotent (only fills NULLs).
//
//   node src/db/fix-department-mapping.js --dry-run
//   node src/db/fix-department-mapping.js
const pool = require('../db');
require('dotenv').config();
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING.\n');

  // Invoices: department = its sales order's division.
  const [invPreview] = await pool.query(
    `SELECT COUNT(*) c FROM sales_invoices si JOIN sales_orders so ON so.id = si.sales_order_id
      WHERE si.department_id IS NULL AND so.sales_division_id IS NOT NULL`);
  console.log(`Invoices to set: ${invPreview[0].c}`);
  if (!DRY_RUN) {
    const [r] = await pool.query(
      `UPDATE sales_invoices si JOIN sales_orders so ON so.id = si.sales_order_id
          SET si.department_id = so.sales_division_id
        WHERE si.department_id IS NULL AND so.sales_division_id IS NOT NULL`);
    console.log(`  updated ${r.affectedRows} invoice(s).`);
  }

  // Customer payments: department = the division of a settled invoice's sales order.
  const [payPreview] = await pool.query(
    `SELECT COUNT(DISTINCT cp.id) c
       FROM customer_payments cp
       JOIN customer_payment_lines cpl ON cpl.customer_payment_id = cp.id
       JOIN sales_invoices si ON si.id = cpl.sales_invoice_id
       JOIN sales_orders so ON so.id = si.sales_order_id
      WHERE cp.department_id IS NULL AND so.sales_division_id IS NOT NULL`);
  console.log(`Customer payments to set: ${payPreview[0].c}`);
  if (!DRY_RUN) {
    const [r] = await pool.query(
      `UPDATE customer_payments cp
         JOIN (SELECT cpl.customer_payment_id AS cp_id, MIN(so.sales_division_id) AS divid
                 FROM customer_payment_lines cpl
                 JOIN sales_invoices si ON si.id = cpl.sales_invoice_id
                 JOIN sales_orders so ON so.id = si.sales_order_id
                WHERE so.sales_division_id IS NOT NULL
                GROUP BY cpl.customer_payment_id) d ON d.cp_id = cp.id
          SET cp.department_id = d.divid
        WHERE cp.department_id IS NULL`);
    console.log(`  updated ${r.affectedRows} customer payment(s).`);
  }

  // Job order dimensions + memo: derive from the sales-order line (import never copied them).
  const [joPrev] = await pool.query(
    `SELECT COUNT(*) c FROM job_orders jo JOIN sales_order_lines sol ON sol.id = jo.sales_order_line_id
      WHERE jo.length IS NULL AND (sol.length IS NOT NULL OR sol.width IS NOT NULL)`);
  console.log(`Job orders to set dims: ${joPrev[0].c}`);
  if (!DRY_RUN) {
    const [r] = await pool.query(
      `UPDATE job_orders jo JOIN sales_order_lines sol ON sol.id = jo.sales_order_line_id
          SET jo.length = sol.length, jo.width = sol.width, jo.height = sol.height,
              jo.memo = COALESCE(jo.memo, NULLIF(sol.remarks, ''), NULLIF(sol.memo, ''))
        WHERE jo.length IS NULL AND (sol.length IS NOT NULL OR sol.width IS NOT NULL)`);
    console.log(`  updated ${r.affectedRows} job order(s).`);
  }

  // Invoice subtotal: import left it 0; it's net_of_tax + discount_amount.
  const [siPrev] = await pool.query(
    'SELECT COUNT(*) c FROM sales_invoices WHERE (subtotal IS NULL OR subtotal = 0) AND net_of_tax > 0');
  console.log(`Invoices to set subtotal: ${siPrev[0].c}`);
  if (!DRY_RUN) {
    const [r] = await pool.query(
      'UPDATE sales_invoices SET subtotal = net_of_tax + COALESCE(discount_amount, 0) WHERE (subtotal IS NULL OR subtotal = 0) AND net_of_tax > 0');
    console.log(`  updated ${r.affectedRows} invoice(s).`);
  }

  if (DRY_RUN) console.log('\nDRY RUN -- nothing written.');
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
