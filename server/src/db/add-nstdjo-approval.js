// One-off migration: adds the SBU approval gate to Non-Standard Job Orders.
//
// A saved NSTDJO now waits on its raiser's own department approver(s) before it can go to
// Design -- the same gate Tickets use (department_ticket_approvers -> ticket_approvers,
// any ONE tagged approver clears it). Approvers are snapshotted per order at creation, so
// later changes to who approves for a department don't retroactively change who is
// responsible for an order already in flight.
//
// Idempotent -- safe to re-run:
//   node src/db/add-nstdjo-approval.js
const pool = require('../db');
require('dotenv').config();

const TABLE = 'non_standard_job_orders';

async function main() {
  const [cols] = await pool.query('SHOW COLUMNS FROM ??', [TABLE]);
  const have = new Set(cols.map((c) => c.Field));

  for (const [name, ddl] of [
    ['approved_at', 'ADD COLUMN approved_at DATETIME NULL AFTER sub_status'],
    ['approved_by_user_id', 'ADD COLUMN approved_by_user_id BIGINT NULL AFTER approved_at'],
  ]) {
    if (have.has(name)) { console.log(`${name} already present.`); continue; }
    await pool.query(`ALTER TABLE ${TABLE} ${ddl}`);
    console.log(`Added ${name}.`);
  }

  const [[existing]] = await pool.query("SHOW TABLES LIKE 'non_standard_job_order_approvers'");
  if (existing) {
    console.log('non_standard_job_order_approvers already present.');
  } else {
    await pool.query(`
      CREATE TABLE non_standard_job_order_approvers (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        non_standard_job_order_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_nstdjo_approver (non_standard_job_order_id, user_id)
      )`);
    console.log('Created non_standard_job_order_approvers.');
  }

  // Orders raised before this gate existed were never sent for approval, so they are
  // treated as already cleared rather than stranded in a queue nobody was told about.
  const [cleared] = await pool.query(
    `UPDATE ${TABLE} SET approved_at = created_at
      WHERE approved_at IS NULL AND sub_status <> 'SBU Approval'`,
  );
  if (cleared.affectedRows) console.log(`Marked ${cleared.affectedRows} pre-existing order(s) as already approved.`);

  const [summary] = await pool.query(
    `SELECT sub_status, COUNT(*) AS orders, SUM(approved_at IS NOT NULL) AS approved FROM ${TABLE} GROUP BY sub_status`,
  );
  console.log('\nNon-Standard Job Orders:');
  console.table(summary);

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
