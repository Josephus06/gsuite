// Estimate > Print Selected (asked 2026-10-28). The estimate's process lines get the source's
// "Print Selected" tick: which lines' items are listed under the job on the two "Print with Selected
// Items" quotations (Hide Discount / Show Discount).
//
//   estimate_job_order_processes.print_selected  TINYINT NULL
//     NULL = never ticked or unticked by anyone: counts as ticked when the line has an item that is
//     not a Service (the materials -- SERVICE LABOR stays off, as the source shows it).
//     1 / 0 = set from the checkbox on the estimate view.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-estimate-print-selected.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[has]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'estimate_job_order_processes' AND column_name = 'print_selected'`);
  if (has.n) console.log('  estimate_job_order_processes.print_selected already there');
  else {
    await pool.query('ALTER TABLE estimate_job_order_processes ADD COLUMN print_selected TINYINT(1) NULL');
    console.log('  estimate_job_order_processes.print_selected added');
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
