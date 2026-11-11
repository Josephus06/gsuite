// Process Location on an estimate's process lines (asked 2026-11-11).
//
// Each process line on an estimate says where the work is done -- the location it starts from is
// the process's own Default Location (Master Lists > Processes), changeable on the line. The job
// order made from the estimate takes it over onto job_order_processes.location_id, which production,
// scheduling and replenishment already read. An estimate / JO process line cannot be saved without it.
//
// Adds estimate_job_order_processes.location_id and fills the existing lines from their process's
// Default Location, in batches so no single transaction swamps replication. Lines whose process has
// no default stay empty -- they get one when next edited.
//
// Idempotent -- run ONCE on the cloud (DDL and data replicate):
//   node src/db/add-estimate-process-location.js
const envName = require('./lib/env')();
const pool = require('../db');

const BATCH = 5000;

async function main() {
  console.log(`Target DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${envName ? ` (--env=${envName})` : ''}`);
  const [cols] = await pool.query("SHOW COLUMNS FROM estimate_job_order_processes LIKE 'location_id'");
  if (cols.length) console.log('location_id already present.');
  else {
    await pool.query(`ALTER TABLE estimate_job_order_processes
      ADD COLUMN location_id BIGINT NULL AFTER item_id,
      ADD CONSTRAINT fk_ejop_location FOREIGN KEY (location_id) REFERENCES locations(id)`);
    console.log('Added location_id.');
  }

  const [[{ maxId }]] = await pool.query('SELECT COALESCE(MAX(id), 0) AS maxId FROM estimate_job_order_processes');
  let filled = 0;
  for (let from = 0; from <= maxId; from += BATCH) {
    const [r] = await pool.query(
      `UPDATE estimate_job_order_processes p JOIN processes pr ON pr.id = p.process_id
          SET p.location_id = pr.default_location_id
        WHERE p.id > ? AND p.id <= ? AND p.location_id IS NULL AND pr.default_location_id IS NOT NULL`,
      [from, from + BATCH],
    );
    filled += r.affectedRows;
  }
  const [[left]] = await pool.query('SELECT COUNT(*) AS n FROM estimate_job_order_processes WHERE location_id IS NULL');
  console.log(`Filled ${filled} line(s) from the process's Default Location; ${left.n} still without one (process has no default).`);
}

main().then(() => pool.end()).catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
