// Adds customer_payments.si_bs_no: the Sales Invoice / Billing Statement number the customer quotes
// on the payment, typed on the Customer Payment form. Free text and optional. Safe to re-run.
//
//   node src/db/add-customer-payment-si-bs-no.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  const [[col]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'customer_payments' AND column_name = 'si_bs_no'`
  );
  if (col.n) console.log('customer_payments.si_bs_no already present');
  else {
    await pool.query('ALTER TABLE customer_payments ADD COLUMN si_bs_no VARCHAR(100) NULL AFTER or_no');
    console.log('added customer_payments.si_bs_no');
  }
  await pool.end();
})().catch((err) => { console.error(err); process.exit(1); });
