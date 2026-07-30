// Adds the columns the NSSO "Create JO" flow needs:
//   job_orders.nsso_id / nsso_line_id       -- nullable back-links so a JO raised from a
//                                               Non-Standard Sales Order is traceable to it
//   non_standard_sales_order_lines.created_job_order_id -- the JO created from that line
// A redo JO reuses the source (nested-SO) job order's sales_order_id + sales_order_line_id (both
// NOT NULL on job_orders), so no core-table constraint has to change.
//
//   node src/db/alter-nsso-create-jo.js
const pool = require('../db');

async function addCol(table, col, ddl) {
  const [ex] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [col]);
  if (ex.length) { console.log(`${table}.${col} already exists.`); return; }
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`Added ${table}.${col}.`);
}

async function main() {
  await addCol('job_orders', 'nsso_id', 'nsso_id BIGINT NULL');
  await addCol('job_orders', 'nsso_line_id', 'nsso_line_id BIGINT NULL');
  await addCol('non_standard_sales_order_lines', 'created_job_order_id', 'created_job_order_id BIGINT NULL');
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
