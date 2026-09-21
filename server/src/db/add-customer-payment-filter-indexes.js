// Indexes for the Customer Payments list filters.
//
// The list is now paged at the database, so a page load reads ten rows plus one COUNT. The COUNT
// is what needs the index: counting a filtered subset of 130,000 payments without one is a full
// table scan, and it runs on every page load, not just the first.
//
// date_created already has an index, and the primary key serves the default ORDER BY cp.id DESC.
// department_id had nothing, so filtering by department scanned the table twice -- once to count,
// once to find ten rows.
//
// idx_cp_department (department_id, date_created) is composite because the two filters are used
// together far more often than apart: "Sales department, this month" is the question people
// actually ask. A leading department_id also serves a department-only filter, so the single-column
// index would be redundant beside it.
//
// NO FOREIGN KEY, matching this schema. ALGORITHM=INPLACE for an index -- INSTANT does not apply
// to index creation, and asking for it would fail.
//
// IDEMPOTENT: safe to re-run; existing indexes are reported and skipped.
//
//   node src/db/add-customer-payment-filter-indexes.js [--dry-run]
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');

const WANTED = [
  ['customer_payments', 'idx_cp_department', '(department_id, date_created)'],
];

async function indexExists(table, name) {
  const [rows] = await pool.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name]);
  return rows.length > 0;
}

(async () => {
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY ? '   (DRY RUN -- nothing will be written)' : ''}`);
    for (const [table, name, cols] of WANTED) {
      if (await indexExists(table, name)) {
        console.log(`  ${table}.${name} exists -- skipped`);
      } else if (DRY) {
        console.log(`  WOULD add ${table}.${name} ${cols}`);
      } else {
        const t0 = Date.now();
        await pool.query(`ALTER TABLE ${table} ADD INDEX ${name} ${cols}`);
        console.log(`  Added ${table}.${name} ${cols}  (${Date.now() - t0}ms)`);
      }
    }
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM customer_payments');
    console.log(`\n${n} customer payments indexed for the list filters.`);
    await pool.end();
  } catch (err) {
    console.error(err);
    await pool.end();
    process.exit(1);
  }
})();
