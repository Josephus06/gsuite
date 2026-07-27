// sales_invoices.department_id / customer_payments.department_id reference the `departments`
// table (org departments, e.g. "Sales - 3") -- that's what the invoice detail and the
// Department Income Statement resolve. An earlier backfill wrongly stored sales_divisions ids
// there, so the income statement mislabeled columns (sales_divisions id 3 "Sales-1" resolved to
// departments id 3 "Accounting", etc.). This re-maps department_id to the departments row whose
// name matches the sales order's division (compared ignoring spaces/dashes/case).
//
//   node src/db/fix-invoice-department.js --dry-run
//   node src/db/fix-invoice-department.js
const pool = require('../db');
require('dotenv').config();
const DRY_RUN = process.argv.includes('--dry-run');
const NORM = "REPLACE(REPLACE(LOWER(??),' ',''),'-','')";

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING.\n');

  // Show the name-based mapping we'll use.
  const [map] = await pool.query(
    `SELECT sd.name AS division, d.id AS dept_id, d.name AS dept
       FROM sales_divisions sd
       JOIN departments d ON ${NORM.replace('??', 'd.name')} = ${NORM.replace('??', 'sd.name')}
      ORDER BY sd.name`);
  console.log('Division -> Department mapping:'); console.table(map);

  // Invoices.
  const [invPrev] = await pool.query(
    `SELECT COUNT(*) c FROM sales_invoices si
       JOIN sales_orders so ON so.id = si.sales_order_id
       JOIN sales_divisions sd ON sd.id = so.sales_division_id
       JOIN departments d ON ${NORM.replace('??', 'd.name')} = ${NORM.replace('??', 'sd.name')}`);
  console.log(`\nInvoices to re-map: ${invPrev[0].c}`);
  if (!DRY_RUN) {
    const [r] = await pool.query(
      `UPDATE sales_invoices si
         JOIN sales_orders so ON so.id = si.sales_order_id
         JOIN sales_divisions sd ON sd.id = so.sales_division_id
         JOIN departments d ON ${NORM.replace('??', 'd.name')} = ${NORM.replace('??', 'sd.name')}
          SET si.department_id = d.id`);
    console.log(`  updated ${r.affectedRows} invoice(s).`);
  }

  // Customer payments (via a settled invoice's sales order division).
  const [payPrev] = await pool.query(
    `SELECT COUNT(DISTINCT cp.id) c FROM customer_payments cp
       JOIN customer_payment_lines cpl ON cpl.customer_payment_id = cp.id
       JOIN sales_invoices si ON si.id = cpl.sales_invoice_id
       JOIN sales_orders so ON so.id = si.sales_order_id
       JOIN sales_divisions sd ON sd.id = so.sales_division_id
       JOIN departments d ON ${NORM.replace('??', 'd.name')} = ${NORM.replace('??', 'sd.name')}`);
  console.log(`Customer payments to re-map: ${payPrev[0].c}`);
  if (!DRY_RUN) {
    const [r] = await pool.query(
      `UPDATE customer_payments cp
         JOIN (SELECT cpl.customer_payment_id AS cp_id, MIN(d.id) AS dept_id
                 FROM customer_payment_lines cpl
                 JOIN sales_invoices si ON si.id = cpl.sales_invoice_id
                 JOIN sales_orders so ON so.id = si.sales_order_id
                 JOIN sales_divisions sd ON sd.id = so.sales_division_id
                 JOIN departments d ON ${NORM.replace('??', 'd.name')} = ${NORM.replace('??', 'sd.name')}
                GROUP BY cpl.customer_payment_id) m ON m.cp_id = cp.id
          SET cp.department_id = m.dept_id`);
    console.log(`  updated ${r.affectedRows} customer payment(s).`);
  }

  if (DRY_RUN) console.log('\nDRY RUN -- nothing written.');
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
