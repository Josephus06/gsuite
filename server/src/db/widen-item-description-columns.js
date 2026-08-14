// Widens the item description columns to TEXT.
//
// inventories.sales_description was varchar(255) and purchase_description varchar(500). Live's
// non-inventory items carry full spec sheets -- a network camera's description runs past 300
// characters, and the longest exceed 500 -- so importing them failed outright on an UPDATE.
//
// The original import-item-masters.js used INSERT IGNORE, which downgrades the same overflow to
// a warning and silently stores a truncated string, so a handful of rows are sitting at exactly
// the old ceiling with their text cut off. Re-running import-item-master-details.js --force after
// this restores them in full.
//
// IDEMPOTENT: checks the current type first and does nothing if already TEXT.
const pool = require('../db');
require('dotenv').config();

const TARGETS = [
  ['inventories', 'sales_description'],
  ['inventories', 'purchase_description'],
];

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  for (const [table, column] of TARGETS) {
    const [[col]] = await pool.query(
      `SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS len
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ? AND COLUMN_NAME = ?`,
      [process.env.DB_NAME, table, column]
    );
    if (!col) { console.log(`${table}.${column}: no such column -- skipped.`); continue; }
    // information_schema returns UPPER_CASE keys in MySQL; read them as they actually arrive
    // rather than assuming the lower-case form.
    const type = String(col.DATA_TYPE || '').toLowerCase();
    if (type === 'text' || type === 'mediumtext' || type === 'longtext') {
      console.log(`${table}.${column}: already ${type} -- nothing to do.`);
      continue;
    }
    const [[before]] = await pool.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE CHAR_LENGTH(${column}) >= ?`, [col.len]
    );
    await pool.query(`ALTER TABLE ${table} MODIFY ${column} TEXT NULL`);
    console.log(`${table}.${column}: ${type}(${col.len}) -> TEXT  (${before.n} row(s) were at the old ceiling)`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
