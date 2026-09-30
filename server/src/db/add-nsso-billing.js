// Lets a Non-Standard Sales Order be delivered and billed the same way a Sales Order is.
//
//   item_deliveries.sales_order_id  -> NULLABLE   a delivery now belongs to a Sales Order OR an NSSO
//   item_deliveries.nsso_id           (new)       the NSSO a delivery was raised from
//   sales_invoices.nsso_id            (new)       the NSSO an invoice bills; its customer comes from it
//   sales_invoice_lines.nsso_line_id  (new)       the NSSO line an invoice line bills
//
// An invoice has exactly one source -- Sales Order, Estimate or NSSO -- and every place that reads
// an invoice's customer takes COALESCE(so.customer_id, e.customer_id, ns.customer_id).
//
// Idempotent. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/add-nsso-billing.js
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
  const [[col]] = await pool.query(
    `SELECT IS_NULLABLE, COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'item_deliveries' AND COLUMN_NAME = 'sales_order_id'`
  );
  if (col.IS_NULLABLE === 'NO') {
    await pool.query(`ALTER TABLE item_deliveries MODIFY sales_order_id ${col.COLUMN_TYPE} NULL`);
    console.log('item_deliveries.sales_order_id is now nullable.');
  } else {
    console.log('item_deliveries.sales_order_id already nullable.');
  }
  await addCol('item_deliveries', 'nsso_id', 'nsso_id BIGINT NULL AFTER sales_order_id');
  await addIndex('item_deliveries', 'idx_item_deliveries_nsso', 'nsso_id');
  await addCol('sales_invoices', 'nsso_id', 'nsso_id BIGINT NULL AFTER estimate_id');
  await addIndex('sales_invoices', 'idx_sales_invoices_nsso', 'nsso_id');
  await addCol('sales_invoice_lines', 'nsso_line_id', 'nsso_line_id BIGINT NULL AFTER sales_order_line_id');
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
