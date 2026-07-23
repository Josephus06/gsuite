// One-off migration: lets an artist run the layout stopwatch on a Non-Standard Job Order
// from Design > Assigned JO, exactly as they already do for a Job Order.
//
// Mirrors job_orders.layout_started_at/layout_ended_at + job_order_layout_sessions. The
// sessions table is what makes Hold/Resume a real stopwatch: each Play opens a row, each
// Hold closes it, and Actual Time Consumed is the sum of the closed spans -- so time spent
// on hold genuinely does not count.
//
// Idempotent -- safe to re-run:
//   node src/db/add-nstdjo-layout-sessions.js
const pool = require('../db');
require('dotenv').config();

const TABLE = 'non_standard_job_orders';

async function main() {
  const [cols] = await pool.query('SHOW COLUMNS FROM ??', [TABLE]);
  const have = new Set(cols.map((c) => c.Field));

  for (const [name, ddl] of [
    ['layout_started_at', 'ADD COLUMN layout_started_at DATETIME NULL AFTER planned_end_at'],
    ['layout_ended_at', 'ADD COLUMN layout_ended_at DATETIME NULL AFTER layout_started_at'],
  ]) {
    if (have.has(name)) { console.log(`${name} already present.`); continue; }
    await pool.query(`ALTER TABLE ${TABLE} ${ddl}`);
    console.log(`Added ${name}.`);
  }

  const [[exists]] = await pool.query("SHOW TABLES LIKE 'non_standard_job_order_layout_sessions'");
  if (exists) {
    console.log('non_standard_job_order_layout_sessions already present.');
  } else {
    await pool.query(`
      CREATE TABLE non_standard_job_order_layout_sessions (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        non_standard_job_order_id BIGINT NOT NULL,
        started_at DATETIME NOT NULL,
        ended_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_nstdjo_layout_session (non_standard_job_order_id)
      )`);
    console.log('Created non_standard_job_order_layout_sessions.');
  }

  const [after] = await pool.query('SHOW COLUMNS FROM ??', [TABLE]);
  console.log('\nLayout columns now:', after.map((c) => c.Field).filter((f) => /layout|planned/.test(f)).join(', '));
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
