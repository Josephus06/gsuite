// Per-process planned dates on the Scheduled JO task table.
//
// job_orders already carries planned_start_date / planned_end_date -- the whole job's
// forecast, set on the Production screen before Acknowledge. That is one span for a job
// that can run across several warehouses over several days: a Design layout line, a SIGN
// cutting line and an LFP printing line on the same order are worked at different times by
// different people, and a single job-level window says nothing about when each is due.
//
// These are the per-line equivalent, set on the Scheduled JO screen where the planner is
// already looking at the task list. Same names and same DATE type as the job-order columns
// deliberately -- they are the same concept one level down, and a DATETIME variant here
// would leave the two reading differently for no gain.
//
// Idempotent -- safe to re-run, and --env picks the install:
//   node src/db/add-process-planned-dates.js
//   node src/db/add-process-planned-dates.js --env=railway
const envName = require('./lib/env')();
const pool = require('../db');

const TABLE = 'job_order_processes';
const COLUMNS = [
  ['planned_start_date', 'ADD COLUMN planned_start_date DATE NULL AFTER assignment_ended_at'],
  ['planned_end_date', 'ADD COLUMN planned_end_date DATE NULL AFTER planned_start_date'],
];

async function main() {
  console.log(`Target DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${envName ? ` (--env=${envName})` : ''}`);
  const [existing] = await pool.query('SHOW COLUMNS FROM ??', [TABLE]);
  const have = new Set(existing.map((c) => c.Field));

  for (const [name, ddl] of COLUMNS) {
    if (have.has(name)) { console.log(`${name} already present.`); continue; }
    await pool.query(`ALTER TABLE ${TABLE} ${ddl}`);
    console.log(`Added ${name}.`);
  }

  const [[counts]] = await pool.query(
    `SELECT COUNT(*) AS lines_total,
            SUM(planned_start_date IS NOT NULL) AS with_start,
            SUM(planned_end_date IS NOT NULL) AS with_end
     FROM ${TABLE}`
  );
  console.log(`\n${TABLE}: ${counts.lines_total} line(s), ${counts.with_start || 0} with a planned start, ${counts.with_end || 0} with a planned end.`);
  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
