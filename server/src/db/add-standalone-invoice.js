// A standalone invoice: billed straight to a customer with item lines and no order behind it --
// how the source bills monthly rent (INV-83455 "RENT FOR SEPTEMBER 2026", item RENTAL).
//
//   sales_invoices.customer_id      (new)  set ONLY on a standalone invoice; every other invoice
//                                           still takes its customer from its Sales Order,
//                                           Estimate or NSSO -- COALESCE(so, e, ns, si.customer_id)
//   sales_invoice_lines.item_id     (new)  the inventory item a standalone line bills; its income
//                                           account is what the line credits in the GL
//
// Idempotent. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/add-standalone-invoice.js
const pool = require('../db');

async function addCol(table, col, ddl) {
  const [ex] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [col]);
  if (ex.length) { console.log(`${table}.${col} already exists.`); return; }
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`Added ${table}.${col}.`);
}

async function addIndex(table, name, cols) {
  const [ex] = await pool.query(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [name]);
  if (ex.length) { console.log(`${table}.${name} already exists.`); return; }
  await pool.query(`ALTER TABLE ${table} ADD INDEX ${name} (${cols})`);
  console.log(`Added index ${table}.${name}.`);
}

async function main() {
  await addCol('sales_invoices', 'customer_id', 'customer_id BIGINT NULL AFTER nsso_id');
  await addIndex('sales_invoices', 'idx_sales_invoices_customer', 'customer_id');
  await addCol('sales_invoice_lines', 'item_id', 'item_id BIGINT NULL AFTER nsso_line_id');
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
