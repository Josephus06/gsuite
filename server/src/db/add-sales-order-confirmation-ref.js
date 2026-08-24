// Adds order_confirmation_ref to sales_orders, which has been missing since the column was
// introduced -- and has been breaking every estimate approval.
//
// WHAT WENT WRONG. add-estimate-order-confirmation.js added order_confirmation_ref to `estimates`,
// and the field was added to both HEADER_FIELDS and SALES_ORDER_HEADER_FIELDS in
// routes/estimates.js. The second of those is the list copied into a new sales order when an
// estimate reaches "Approved" -- so the INSERT names a column that sales_orders does not have,
// and MySQL rejects it:
//
//   Unknown column 'order_confirmation_ref' in 'field list'
//
// The estimate's status change and the sales order are in one transaction, so the whole approval
// rolls back. Not a partial failure -- approving simply does not work, for any estimate, on any
// install where the estimate half of the migration ran and this half did not. Which is all of
// them, because this half did not exist.
//
// The column carries the customer's order-confirmation number onto the order snapshot, next to
// order_confirmation_type which was already there. VARCHAR(100) NULL, matching the estimates
// column it is copied from -- a narrower type would silently truncate a long reference.
//
// Idempotent -- safe to re-run:
//   node src/db/add-sales-order-confirmation-ref.js
const pool = require('../db');
require('dotenv').config();

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [[{ n }]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'sales_orders' AND column_name = 'order_confirmation_ref'`,
    [process.env.DB_NAME],
  );

  if (n) {
    console.log('sales_orders.order_confirmation_ref already present.');
  } else {
    // ALGORITHM=INSTANT so a table with 69,000-odd orders is not rewritten and does not lock.
    await pool.query(
      'ALTER TABLE sales_orders ADD COLUMN order_confirmation_ref VARCHAR(100) NULL AFTER order_confirmation_type, ALGORITHM=INSTANT',
    );
    console.log('sales_orders.order_confirmation_ref added.');
  }

  // Proves the thing that was actually broken now works, rather than just reporting the DDL ran.
  // The INSERT the approval performs names every column in SALES_ORDER_HEADER_FIELDS; if any
  // other one is missing too, this is where it shows up.
  const [cols] = await pool.query(
    `SELECT column_name AS c FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'sales_orders'`,
    [process.env.DB_NAME],
  );
  const have = new Set(cols.map((r) => r.c));
  const NEEDED = [
    'estimate_id', 'date_created', 'customer_id', 'contact_person_id', 'contact_email', 'contact_title',
    'contact_phone', 'blanket_po_id', 'blanket_po_memo', 'sales_rep_id', 'sales_division_id',
    'office_location_id', 'contract_description', 'memo', 'shipping_address', 'production_lead_time',
    'price_validity', 'order_confirmation_type', 'order_confirmation_ref', 'prepared_by_id',
    'approved_by_id', 'credit_term', 'credit_limit', 'credit_balance', 'bill_to_contact_number',
    'subtotal', 'discount_total', 'net_of_tax', 'tax_total', 'total_amount', 'est_gp_rate', 'est_gp_amount',
  ];
  const missing = NEEDED.filter((c) => !have.has(c));
  console.log(`\nColumns the approval INSERT needs: ${NEEDED.length}, missing: ${missing.length}`);
  if (missing.length) {
    console.log(`  STILL MISSING: ${missing.join(', ')}`);
    console.log('  Approval will keep failing until these exist.');
    process.exitCode = 1;
  } else {
    console.log('  All present -- approving an estimate can generate its sales order.');
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
