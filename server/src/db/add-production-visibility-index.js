// Index behind the Production list's department scoping.
//
// A production department sees its own warehouse's work, which includes job orders FILED
// somewhere else that carry a line worked at its warehouse (routes/production.js). Answering
// "which job orders have a line at location X" means reading job_order_processes by location_id
// -- and the only index on that column is location_id alone, which across 9 warehouses and
// 413,376 lines is barely better than a scan: 74,077 rows for Warehouse - Sign, every one of
// them a row read just to collect its job_order_id.
//
// (location_id, job_order_id) makes that lookup covering -- the id comes out of the index and
// the table is never touched. EXPLAIN goes to `ref` + `Using index`, and the Production list's
// visible-id subquery measured 1,480ms -> ~550ms on the OR form it replaced, with the final
// join form landing at ~140ms.
//
// TAKES A WHILE. This is 413k rows and the build measured ~21 minutes on a loaded dev machine;
// budget for it on a busy or slow-disk install. MySQL 8 builds it online (ALGORITHM=INPLACE),
// so reads and writes to job_order_processes keep working while it runs -- but do not start it
// and walk away from a deploy that is waiting on it.
//
// Idempotent -- safe to re-run, and --env picks the install:
//   node src/db/add-production-visibility-index.js
//   node src/db/add-production-visibility-index.js --env=railway
const envName = require('./lib/env')();
const pool = require('../db');

const TABLE = 'job_order_processes';
const NAME = 'idx_jop_location_job';
const COLUMNS = '(location_id, job_order_id)';

async function main() {
  console.log(`Target DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${envName ? ` (--env=${envName})` : ''}`);
  const [existing] = await pool.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [TABLE, NAME]);
  if (existing.length) {
    console.log(`${NAME} already present.`);
  } else {
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    console.log(`Creating ${NAME} on ${TABLE} ${COLUMNS} over ${n} row(s) -- this can take many minutes...`);
    const started = Date.now();
    await pool.query(`CREATE INDEX ${NAME} ON ${TABLE} ${COLUMNS}`);
    console.log(`Created in ${Math.round((Date.now() - started) / 1000)}s.`);
  }

  const [plan] = await pool.query(`EXPLAIN SELECT job_order_id FROM ${TABLE} WHERE location_id = (SELECT MIN(location_id) FROM ${TABLE} WHERE location_id IS NOT NULL)`);
  const row = plan.find((p) => p.table === TABLE) || plan[0];
  console.log(`\nLookup plan: key=${row?.key || 'none'} type=${row?.type} extra=${row?.Extra || ''}`);
  if (row?.key !== NAME) console.log('  NOTE: the optimizer is not choosing this index -- run ANALYZE TABLE job_order_processes.');

  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
