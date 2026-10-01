// A Bill Credit made from a Cheque (2026-10-01): the cheque screen's "Bill Credit" button, as the
// Vendor Bill screen has one. Such a credit has no vendor bill, so:
//   bill_credits.vendor_bill_id  NOT NULL -> NULL
//   bill_credits.supplier_id     whose credit it is when there is no bill to say so
//   bill_credits.cheque_id       the cheque it was created from
// Every reader takes the vendor from the bill first, then supplier_id.
//
//   node src/db/add-bill-credit-from-cheque.js
// Idempotent. MUST run before the code that reads these columns (bill credit list / view 500
// without them). Droplet and office replicate, but run it on both and trust the skip.
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[vb]] = await pool.query("SHOW COLUMNS FROM bill_credits LIKE 'vendor_bill_id'");
  if (vb.Null === 'NO') {
    await pool.query(`ALTER TABLE bill_credits MODIFY vendor_bill_id ${vb.Type} NULL`);
    console.log('bill_credits.vendor_bill_id: now NULL-able.');
  } else console.log('bill_credits.vendor_bill_id already NULL-able.');
  for (const [col, ddl] of [
    ['supplier_id', 'ADD COLUMN supplier_id BIGINT NULL AFTER vendor_bill_id, ADD KEY idx_bc_supplier (supplier_id)'],
    ['cheque_id', 'ADD COLUMN cheque_id BIGINT NULL AFTER supplier_id, ADD KEY idx_bc_cheque (cheque_id)'],
  ]) {
    const [c] = await pool.query('SHOW COLUMNS FROM bill_credits LIKE ?', [col]);
    if (c.length) console.log(`bill_credits.${col} already present.`);
    else { await pool.query(`ALTER TABLE bill_credits ${ddl}`); console.log(`Added bill_credits.${col}.`); }
  }
  await pool.end();
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
