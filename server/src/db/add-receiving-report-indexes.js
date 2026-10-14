// The indexes behind Purchasing > Receiving Report (asked 2026-10-14: "took too long to load").
//
// purchase_order_receipt_lines (~36,000 rows) had no index on purchase_order_receipt_id, so the
// list's Lines / Qty Received columns scanned the whole table twice for each of the 100 receipts on
// a page (~7 million rows a load), and its Location / Department filters once per receipt in the
// table. purchase_order_receipts had none on its PO or its date (the list's sort, a PO's receipts).
//
// NO FOREIGN KEY, matching this schema.
//
// IDEMPOTENT: safe to re-run; an existing index is reported and skipped.
// Droplet and office replicate: run on ONE box (the droplet); the ALTERs replicate.
//
//   node src/db/add-receiving-report-indexes.js [--dry-run]
const envName = require('./lib/env')();
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const INDEXES = [
  { table: 'purchase_order_receipt_lines', name: 'idx_po_receipt_lines_receipt', cols: 'purchase_order_receipt_id' },
  { table: 'purchase_order_receipt_lines', name: 'idx_po_receipt_lines_location', cols: 'location_id' },
  { table: 'purchase_order_receipt_lines', name: 'idx_po_receipt_lines_po_line', cols: 'purchase_order_line_id' },
  { table: 'purchase_order_receipts', name: 'idx_po_receipts_po', cols: 'purchase_order_id' },
  { table: 'purchase_order_receipts', name: 'idx_po_receipts_date', cols: 'date_created, id' },
];

(async () => {
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${envName ? ` (--env=${envName})` : ''}${DRY ? '   (DRY RUN -- nothing will be written)' : ''}`);
    for (const { table, name, cols } of INDEXES) {
      const [have] = await pool.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name]);
      if (have.length) {
        console.log(`  ${table}.${name} exists -- skipped`);
      } else if (DRY) {
        console.log(`  WOULD add ${table}.${name} (${cols})`);
      } else {
        const t0 = Date.now();
        await pool.query(`ALTER TABLE ${table} ADD INDEX ${name} (${cols})`);
        console.log(`  Added ${table}.${name} (${cols})  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      }
    }
    await pool.end();
  } catch (err) {
    console.error('Failed:', err.message);
    await pool.end();
    process.exit(1);
  }
})();
