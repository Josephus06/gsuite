// Adds the Sales revision loop to Non-Standard Job Orders.
//
// When an artist sends a layout for Sales Approval, Sales could previously only accept it. If the
// work needed changing there was no way to say so in the system -- it happened by walking over, and
// nothing recorded that it had happened at all.
//
// Sales can now send it back. The order returns to the artist as "For Artist (Revision)", which is
// deliberately a DIFFERENT sub-status from the ordinary "For Artist": the artist's queue should
// show at a glance that this one is a rework, not new work.
//
// THE TIMER IS NOT RESET. layout_started_at and layout_ended_at stay exactly as they are. The
// artist has already done that work and their incentive and performance figures are calculated from
// those timestamps -- restarting the clock on a revision would quietly erase the effort already
// recorded against them. A revision notifies; it does not rewrite history.
//
// Three revisions per order, then the button stops. Without a ceiling, "send it back" becomes a
// substitute for deciding what is actually wanted, and an order can circle indefinitely with the
// artist absorbing the cost each time. The counter is per order and never resets.
//
// Idempotent -- safe to re-run:
//   node src/db/add-nstdjo-sales-revision.js
const pool = require('../db');
require('dotenv').config();

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [cols] = await pool.query(
    `SELECT COLUMN_NAME AS cn FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'non_standard_job_orders'
        AND COLUMN_NAME IN ('sales_revision_count', 'last_revision_at', 'last_revision_note')`,
    [process.env.DB_NAME]
  );
  const have = new Set(cols.map((c) => c.cn));

  const additions = [
    ['sales_revision_count', 'INT NOT NULL DEFAULT 0'],
    ['last_revision_at', 'DATETIME NULL'],
    // Sales says what needs changing. A revision with no reason is just a rejection, and the
    // artist is left guessing at what to alter.
    ['last_revision_note', 'VARCHAR(500) NULL'],
  ];

  for (const [name, ddl] of additions) {
    if (have.has(name)) { console.log(`non_standard_job_orders.${name} already present.`); continue; }
    await pool.query(`ALTER TABLE non_standard_job_orders ADD COLUMN ${name} ${ddl}`);
    console.log(`non_standard_job_orders.${name} added.`);
  }

  // status and sub_status are varchar(50), so "For Artist (Revision)" (21 chars) needs no schema
  // change -- unlike estimates.status, which is an ENUM and would have required one.
  const [[width]] = await pool.query(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'non_standard_job_orders' AND COLUMN_NAME = 'sub_status'`,
    [process.env.DB_NAME]
  );
  console.log(`sub_status is varchar(${width.len}); "For Artist (Revision)" is 21 chars -- fits.`);

  const [[n]] = await pool.query(
    'SELECT COUNT(*) AS n, COALESCE(SUM(sales_revision_count), 0) AS revisions FROM non_standard_job_orders'
  );
  console.log(`\nnon_standard_job_orders: ${n.n} order(s), ${n.revisions} revision(s) recorded.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
