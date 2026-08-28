// Indexes behind the derived On Hand.
//
// lib/stockLedger.js sums an item's movements out of six line tables to get its on-hand, and the
// Production screen does that on every Job Order it opens. Four of those six tables shipped with
// no index on item_id, so each of those reads was a full table scan -- 165,000 rows across the
// four, on the most-opened screen in the module.
//
// The fifth and sixth (assembly_build_lines, inventory_adjustment_lines) already have one. Note
// that an index does not save assembly_build_lines from a scan when the item being summed is
// SERVICE LABOR, which sits on a large share of all 433,850 of its rows: no index is selective
// for an item that common. That is handled in the caller instead, by never asking for a service
// item's on-hand -- it has no shelf.
//
// Cheap to build: all four measured under a second on 35k-65k rows.
//
// Idempotent -- safe to re-run, and --env picks the install:
//   node src/db/add-stock-movement-indexes.js
//   node src/db/add-stock-movement-indexes.js --env=railway
const envName = require('./lib/env')();
const pool = require('../db');

const TABLES = [
  'purchase_order_receipt_lines',
  'purchase_return_lines',
  'item_fulfillment_lines',
  'item_receipt_lines',
];

async function main() {
  console.log(`Target DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${envName ? ` (--env=${envName})` : ''}\n`);
  for (const table of TABLES) {
    const name = `idx_${table}_item`;
    const [have] = await pool.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name]);
    if (have.length) { console.log(`${name} already present.`); continue; }
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
    const started = Date.now();
    await pool.query(`CREATE INDEX ${name} ON ${table} (item_id)`);
    console.log(`Created ${name} over ${n} row(s) in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  }
  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
