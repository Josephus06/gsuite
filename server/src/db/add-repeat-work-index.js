// Makes "we have made this before" answerable in milliseconds.
//
// A third of everything this company prints, it has printed before: 6,981 job descriptions
// appear more than once, across 40,845 job orders. The priced history lives in
// sales_order_lines -- 126,539 lines carrying a description, a quantity, a unit, a size and
// the price that was actually charged.
//
// Unindexed, the lookup takes ~470ms against 128k rows, which is too slow to sit under a
// field somebody is typing into. A plain index on `description` is enough because the column
// is utf8mb4_unicode_ci: `description = ?` is already case-insensitive, so the query needs no
// UPPER() and can therefore use the index. Wrapping the column in a function was the obvious
// first draft and would have disabled the index entirely.
//
// Prefix length 100: the longest descriptions run to a few hundred characters, but the first
// 100 are more than enough to separate "POSTER" from "PVC ID", and a full-width index on a
// varchar(255) in utf8mb4 would be four times the size for no extra selectivity.
//
// A second index on (description, units) serves the narrowing the endpoint does next -- the
// same description in a different unit is a different job, and it is the first thing filtered
// after the description matches.
//
// IDEMPOTENT: safe to re-run; existing indexes are reported and skipped.
//
//   node src/db/add-repeat-work-index.js
const pool = require('../db');

async function indexExists(table, name) {
  const [rows] = await pool.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name]);
  return rows.length > 0;
}

async function addIndex(table, name, definition) {
  if (await indexExists(table, name)) {
    console.log(`  ${table}.${name} exists -- skipped`);
    return;
  }
  // ALGORITHM=INPLACE so the table stays readable and writable while it builds; 128k rows is
  // quick, but this table is on the path of every sales order being saved.
  const ddl = `ALTER TABLE ${table} ADD INDEX ${name} ${definition}`;
  try {
    await pool.query(`${ddl}, ALGORITHM=INPLACE, LOCK=NONE`);
  } catch (err) {
    if (err.errno !== 1064 && err.errno !== 1846) throw err;
    console.log(`  (this MySQL will not do it INPLACE; building ${name} the ordinary way)`);
    await pool.query(ddl);
  }
  console.log(`  Added ${table}.${name}`);
}

(async () => {
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
    await addIndex('sales_order_lines', 'idx_sol_description', '(description(100))');
    await addIndex('sales_order_lines', 'idx_sol_description_units', '(description(100), units)');

    const [[stats]] = await pool.query(
      `SELECT COUNT(*) AS priced,
              SUM(gp_rate > 0) AS with_gp,
              COUNT(DISTINCT description) AS distinct_descriptions
         FROM sales_order_lines WHERE price_per_unit > 0`
    );
    console.log(`\n${stats.priced} priced lines across ${stats.distinct_descriptions} distinct descriptions.`);
    console.log(`${stats.with_gp} of them carry a real GP rate -- the rest are 0, which is why the`);
    console.log('endpoint reports GP only over the rows that have one and says how many that was.');
    await pool.end();
  } catch (err) {
    console.error(err);
    await pool.end();
    process.exit(1);
  }
})();
