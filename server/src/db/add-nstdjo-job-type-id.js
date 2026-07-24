// One-off migration: adds non_standard_job_orders.job_type_id.
//
// The column had only ever been added by hand to a local database -- it was never in
// schema.sql -- so any database built from the repo, production included, had only the
// job_type display-name column. Saving an order then fails with
// "Unknown column 'job_type_id' in 'field list'".
//
// Both columns are kept on purpose: job_type_id is the real link to the master list, and
// job_type holds the display name as it stood when the order was raised, so renaming a
// job type later cannot restate what an existing order was for.
//
// Backfills job_type_id from the stored name for any rows raised before the column
// existed. Idempotent -- safe to re-run:
//   node src/db/add-nstdjo-job-type-id.js
const pool = require('../db');
require('dotenv').config();

const TABLE = 'non_standard_job_orders';
const NSTDJO_JO_TYPE = 'Non Standard JO';

async function main() {
  const [cols] = await pool.query('SHOW COLUMNS FROM ??', [TABLE]);
  if (cols.some((c) => c.Field === 'job_type_id')) {
    console.log('job_type_id already present.');
  } else {
    await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN job_type_id BIGINT NULL AFTER job_location_id`);
    console.log('Added job_type_id.');
  }

  // Match existing rows to the master list by the name they were saved with.
  // Both sides are forced to one collation: these two columns can differ between
  // databases (a schema declaring utf8mb4_unicode_ci against a MySQL 9 server defaulting
  // to utf8mb4_0900_ai_ci), and comparing them raw fails with "Illegal mix of collations".
  const [filled] = await pool.query(
    `UPDATE ${TABLE} n
       JOIN job_types j
         ON CONVERT(j.display_name USING utf8mb4) COLLATE utf8mb4_general_ci
          = CONVERT(n.job_type USING utf8mb4) COLLATE utf8mb4_general_ci
        AND CONVERT(j.jo_type USING utf8mb4) COLLATE utf8mb4_general_ci
          = CONVERT(? USING utf8mb4) COLLATE utf8mb4_general_ci
        SET n.job_type_id = j.id
      WHERE n.job_type_id IS NULL`,
    [NSTDJO_JO_TYPE],
  );
  console.log(filled.affectedRows
    ? `Backfilled job_type_id on ${filled.affectedRows} existing order(s).`
    : 'No rows needed backfilling.');

  const [[orphans]] = await pool.query(
    `SELECT COUNT(*) AS c FROM ${TABLE} WHERE job_type_id IS NULL`,
  );
  if (orphans.c) {
    // Left for a human: the stored name matches no active master row, so guessing which
    // job type was meant would be inventing data.
    const [names] = await pool.query(
      `SELECT DISTINCT job_type FROM ${TABLE} WHERE job_type_id IS NULL`,
    );
    console.warn(`\n!! ${orphans.c} order(s) still have no job_type_id.`);
    console.warn(`   Unmatched job_type name(s): ${names.map((n) => n.job_type).join(', ')}`);
    console.warn('   These need the matching job_types row, or the name corrected, by hand.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
