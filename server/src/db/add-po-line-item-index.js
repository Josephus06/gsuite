// The index behind "Compare" on a Purchase Order line.
//
// GET /purchase-orders/item-price-history/:itemId asks purchase_order_lines for every line
// carrying one item. That table shipped with no index on item_id, so the question was a full
// table scan -- and it is asked from a button sitting on every line of every purchase order.
//
// (purchase_order_receipt_lines, the other half of that query, already gets its item_id index
// from add-stock-movement-indexes.js. Run that one too if this database predates it.)
//
// NO FOREIGN KEY, matching this schema.
//
// IDEMPOTENT: safe to re-run; an existing index is reported and skipped.
//
//   node src/db/add-po-line-item-index.js [--dry-run]
//   node src/db/add-po-line-item-index.js --env=railway
const envName = require('./lib/env')();
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const TABLE = 'purchase_order_lines';
const NAME = 'idx_purchase_order_lines_item';

(async () => {
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${envName ? ` (--env=${envName})` : ''}${DRY ? '   (DRY RUN -- nothing will be written)' : ''}`);
    const [have] = await pool.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [TABLE, NAME]);
    if (have.length) {
      console.log(`  ${TABLE}.${NAME} exists -- skipped`);
    } else if (DRY) {
      console.log(`  WOULD add ${TABLE}.${NAME} (item_id)`);
    } else {
      const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${TABLE}`);
      const t0 = Date.now();
      await pool.query(`ALTER TABLE ${TABLE} ADD INDEX ${NAME} (item_id)`);
      console.log(`  Added ${TABLE}.${NAME} (item_id) over ${n} row(s)  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
    await pool.end();
  } catch (err) {
    console.error('Failed:', err.message);
    await pool.end();
    process.exit(1);
  }
})();
