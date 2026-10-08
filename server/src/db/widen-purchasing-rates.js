// Purchasing per-unit rates to 6 decimal places (asked 2026-10-08): the rate on a PO, receipt,
// purchase return and vendor bill line, and the vendor bill's unit price. Line totals, tax and
// document totals stay at 2 decimals, so every document still adds up to the centavo.
//
// DECIMAL(14,4) -> DECIMAL(18,6): two more decimals and the same 12 whole-number digits, so every
// stored value fits unchanged. Safe to re-run: a column already at scale 6 is skipped.
//
//   node src/db/widen-purchasing-rates.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const COLUMNS = [
  ['purchase_order_lines', 'rate'],
  ['purchase_order_receipt_lines', 'rate'],
  ['purchase_return_lines', 'rate'],
  ['vendor_bill_lines', 'rate'],
  ['vendor_bill_lines', 'unit_price'],
];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const [table, column] of COLUMNS) {
    const [[c]] = await pool.query(
      `SELECT NUMERIC_SCALE scale, COLUMN_TYPE type FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]);
    if (!c) { console.log(`  ${table}.${column}: not found -- skipped`); continue; }
    if (Number(c.scale) >= 6) { console.log(`  ${table}.${column}: already ${c.type} -- skipped`); continue; }
    await pool.query(`ALTER TABLE ${table} MODIFY COLUMN ${column} DECIMAL(18,6) NULL DEFAULT 0`);
    console.log(`  ${table}.${column}: ${c.type} -> decimal(18,6)`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
