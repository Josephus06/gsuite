// A Customer Payment can be applied to a Customer Refund (asked 2026-11-05), as to an invoice.
// A refund debits A/R (DR 12100 / CR 10005), so it is an open A/R item like an invoice until a
// payment is applied to it: the payment's APPLY tab lists the customer's open refunds, and what is
// applied credits A/R in the payment's GL (in place of 23000 Customer Deposits for that part).
//
// customer_payment_lines.customer_refund_id: the refund a line applies to (a line carries one of
// sales_invoice_id, credit_memo_id, customer_refund_id). A refund's amount due is derived on read --
// refund_amount less what non-voided payments apply to it -- so nothing else is stored.
//
// Idempotent.
//   node src/db/add-payment-refund-apply.js --dry-run
//   node src/db/add-payment-refund-apply.js
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY ? ' -- DRY RUN' : ''}\n`);
  const [cols] = await pool.query("SHOW COLUMNS FROM customer_payment_lines LIKE 'customer_refund_id'");
  if (cols.length) console.log('= customer_payment_lines.customer_refund_id already exists');
  else if (DRY) console.log('~ would add customer_payment_lines.customer_refund_id (+ index)');
  else {
    await pool.query(
      `ALTER TABLE customer_payment_lines
         ADD COLUMN customer_refund_id BIGINT NULL AFTER credit_memo_id,
         ADD INDEX idx_cpl_customer_refund (customer_refund_id)`);
    console.log('+ customer_payment_lines.customer_refund_id');
  }
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
