// Indexes for an invoice's settlements (2026-10-12). Amount Due is now worked out on GROSS -- Gross
// less the payments and credit memos applied to the invoice (lib/invoiceDue.js) -- which looks up
// customer_payment_lines and credit_memo_applications BY INVOICE. Neither table had an index on
// sales_invoice_id, so every lookup read the whole table: a single customer's open-invoice list ran
// past five minutes. Run before deploying the code that uses it.
//
// Idempotent.
//   node src/db/add-invoice-settlement-indexes.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const INDEXES = [
  ['customer_payment_lines', 'idx_cpl_sales_invoice', 'sales_invoice_id'],
  ['credit_memo_applications', 'idx_cma_sales_invoice', 'sales_invoice_id'],
];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const [table, name, column] of INDEXES) {
    const [have] = await pool.query('SHOW INDEX FROM ?? WHERE Column_name = ? AND Seq_in_index = 1', [table, column]);
    if (have.length) { console.log(`${table}.${column}: already indexed (${have[0].Key_name}).`); continue; }
    const t = Date.now();
    await pool.query(`ALTER TABLE ?? ADD INDEX ?? (??)`, [table, name, column]);
    console.log(`${table}.${column}: indexed in ${((Date.now() - t) / 1000).toFixed(1)}s.`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
