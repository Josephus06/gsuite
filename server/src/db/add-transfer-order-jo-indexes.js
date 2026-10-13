// The indexes behind a Job Order's Transfer Orders (Related Records tab, d887a2b).
//
// GET /job-orders/:id and GET /production/:id ask which Transfer Orders belong to a JO -- on the TO
// itself or on one of its lines -- and how much each moved. transfer_order_lines had no index on
// transfer_order_id or job_order_id, nor transfer_orders on job_order_id, so every JO opened scanned
// the whole lines table once per transfer order. On 2026-10-13 that held 22 queries running for up to
// 23 minutes on the droplet and pinned all 4 cores.
//
// NO FOREIGN KEY, matching this schema.
//
// IDEMPOTENT: safe to re-run; an existing index is reported and skipped.
// Droplet and office replicate: run on ONE box (the droplet); the ALTERs replicate.
//
//   node src/db/add-transfer-order-jo-indexes.js [--dry-run]
const envName = require('./lib/env')();
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const INDEXES = [
  { table: 'transfer_order_lines', name: 'idx_transfer_order_lines_to', cols: 'transfer_order_id' },
  { table: 'transfer_order_lines', name: 'idx_transfer_order_lines_jo', cols: 'job_order_id' },
  { table: 'transfer_orders', name: 'idx_transfer_orders_jo', cols: 'job_order_id' },
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
        const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
        const t0 = Date.now();
        await pool.query(`ALTER TABLE ${table} ADD INDEX ${name} (${cols})`);
        console.log(`  Added ${table}.${name} (${cols}) over ${n} row(s)  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      }
    }
    await pool.end();
  } catch (err) {
    console.error('Failed:', err.message);
    await pool.end();
    process.exit(1);
  }
})();
