// customer_payments.prepared_by_name / issued_by_name -- who prepared and who issued a payment, as
// the source names them. Migrated payments have no T1S user behind either (created_by_user_id and
// issued_by_user_id are NULL on all of them), so the names are kept as text; see
// lib/paymentHeader.js. A payment made in T1S still records its users by id as before.
//
//   node src/db/add-customer-payment-people.js
//
// Idempotent. Run on ONE box of the droplet/office pair; replication carries the DDL.
require('dotenv').config();
const pool = require('../db');

const COLUMNS = [
  ['prepared_by_name', 'ADD COLUMN prepared_by_name VARCHAR(150) NULL AFTER created_by_user_id'],
  ['issued_by_name', 'ADD COLUMN issued_by_name VARCHAR(150) NULL AFTER issued_by_user_id'],
];

(async () => {
  for (const [col, ddl] of COLUMNS) {
    const [have] = await pool.query('SHOW COLUMNS FROM customer_payments LIKE ?', [col]);
    if (have.length) { console.log(`customer_payments.${col} already present.`); continue; }
    await pool.query(`ALTER TABLE customer_payments ${ddl}`);
    console.log(`Added customer_payments.${col}.`);
  }
})()
  .catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
