// Lets a Sales Invoice be raised straight from an Estimate, with no Sales Order behind it.
//
// Until now every invoice came from a Sales Order -- sales_invoices.sales_order_id was NOT NULL,
// and both the list and the detail query reached the customer through an INNER JOIN on it. An
// invoice raised against an Estimate has no Sales Order and no Job Orders yet: those come later,
// when the Estimate is converted. So the column becomes nullable and an estimate_id sits beside
// it, exactly one of the two being set.
//
// The lines need the same treatment. sales_invoice_lines already allows a null job_order_id (88%
// of them have one, the rest are ad-hoc delivery-ticket charges), which is what lets an
// estimate-sourced line leave the JO # column empty. It gains estimate_job_order_id to say which
// Estimate line it came from, and job_type_id because the Item and Item Code columns are resolved
// through the job order or the sales-order line today -- an estimate line has neither, so without
// this the invoice would print with a blank Item.
//
// NOTHING IS BACKFILLED. Every existing invoice keeps its sales_order_id and gets a null
// estimate_id, which is exactly what it is: an invoice that came from a Sales Order.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-invoice-from-estimate.js
require('dotenv').config();
const pool = require('../db');

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}
async function indexExists(table, index) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, [table, index],
  );
  return r.n > 0;
}
async function isNullable(table, column) {
  const [[r]] = await pool.query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r && r.is_nullable === 'YES';
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  if (await isNullable('sales_invoices', 'sales_order_id')) {
    console.log('  sales_invoices.sales_order_id is already nullable -- skipped.');
  } else {
    await pool.query('ALTER TABLE sales_invoices MODIFY COLUMN sales_order_id BIGINT NULL');
    console.log('  sales_invoices.sales_order_id is now nullable.');
  }

  if (await columnExists('sales_invoices', 'estimate_id')) {
    console.log('  sales_invoices.estimate_id already exists -- skipped.');
  } else {
    await pool.query('ALTER TABLE sales_invoices ADD COLUMN estimate_id BIGINT NULL AFTER sales_order_id');
    console.log('  sales_invoices.estimate_id added.');
  }
  if (await indexExists('sales_invoices', 'idx_sales_invoices_estimate')) {
    console.log('  idx_sales_invoices_estimate already exists -- skipped.');
  } else {
    await pool.query('CREATE INDEX idx_sales_invoices_estimate ON sales_invoices (estimate_id)');
    console.log('  idx_sales_invoices_estimate created.');
  }

  for (const [col, ddl] of [
    ['estimate_job_order_id', 'ADD COLUMN estimate_job_order_id BIGINT NULL AFTER sales_order_line_id'],
    ['job_type_id', 'ADD COLUMN job_type_id BIGINT NULL AFTER estimate_job_order_id'],
  ]) {
    if (await columnExists('sales_invoice_lines', col)) {
      console.log(`  sales_invoice_lines.${col} already exists -- skipped.`);
    } else {
      await pool.query(`ALTER TABLE sales_invoice_lines ${ddl}`);
      console.log(`  sales_invoice_lines.${col} added.`);
    }
  }

  const [[counts]] = await pool.query(
    `SELECT COUNT(*) AS invoices,
            SUM(sales_order_id IS NOT NULL) AS from_sales_order,
            SUM(estimate_id IS NOT NULL) AS from_estimate,
            SUM(sales_order_id IS NULL AND estimate_id IS NULL) AS orphaned
       FROM sales_invoices`,
  );
  console.log(`\n  ${counts.invoices} invoice(s): ${counts.from_sales_order} from a Sales Order, `
    + `${counts.from_estimate} from an Estimate, ${counts.orphaned} from neither.`);
  if (Number(counts.orphaned) > 0) {
    console.log('  WARNING: an invoice with neither source should not exist -- check the rows above.');
  }

  await pool.end();
}

main().catch(async (err) => { console.error('Failed:', err.message); await pool.end(); process.exit(1); });
