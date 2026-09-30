// A standalone (expense) vendor bill: a supplier's bill with no Purchase Order behind it -- rent,
// utilities, freight, professional fees. The source raises 684 of these in 2026 alone (18.3M).
//
//   vendor_bills.purchase_order_id          -> NULLABLE  a bill has a PO, or is standalone
//   vendor_bills.supplier_id                  (new)      set ONLY on a standalone bill; a PO bill's
//                                                        supplier is still its PO's, read everywhere
//                                                        as COALESCE(po.supplier_id, vb.supplier_id)
//   vendor_bill_lines.purchase_order_line_id -> NULLABLE
//   vendor_bill_lines.item_id                -> NULLABLE an expense line has an account, not an item
//   vendor_bill_lines.account_id              (new)      the expense account the line debits
//   vendor_bill_lines.description             (new)
//
// Idempotent. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/add-standalone-vendor-bill.js
const pool = require('../db');

async function makeNullable(table, col) {
  const [[c]] = await pool.query(
    `SELECT IS_NULLABLE, COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, col]);
  if (!c) throw new Error(`${table}.${col} not found`);
  if (c.IS_NULLABLE === 'YES') { console.log(`${table}.${col} already nullable.`); return; }
  await pool.query(`ALTER TABLE ${table} MODIFY ${col} ${c.COLUMN_TYPE} NULL`);
  console.log(`${table}.${col} is now nullable.`);
}

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
  await makeNullable('vendor_bills', 'purchase_order_id');
  await addCol('vendor_bills', 'supplier_id', 'supplier_id BIGINT NULL AFTER purchase_order_id');
  await addIndex('vendor_bills', 'idx_vendor_bills_supplier', 'supplier_id');
  await makeNullable('vendor_bill_lines', 'purchase_order_line_id');
  await makeNullable('vendor_bill_lines', 'item_id');
  await addCol('vendor_bill_lines', 'account_id', 'account_id BIGINT NULL AFTER item_id');
  await addCol('vendor_bill_lines', 'description', 'description VARCHAR(500) NULL AFTER account_id');
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
