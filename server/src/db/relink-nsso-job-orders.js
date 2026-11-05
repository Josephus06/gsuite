// One-off repair (2026-11-05): links every NSSO item back to the job order already created from it
// (lib/nssoRelink.js). Items were cut off from their job orders when the NSSO's items were re-saved,
// so the NSSO showed "Create JO" for an item that had one (NSSO-INT-2050: NSJO-INT-2050-1-2 and
// -2-2 existed). Opening an NSSO now relinks it too; this does them all at once.
//
// Idempotent.
//   node src/db/relink-nsso-job-orders.js --dry-run
//   node src/db/relink-nsso-job-orders.js
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { relinkNsso } = require('../lib/nssoRelink');

const DRY = process.argv.includes('--dry-run');

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY ? ' -- DRY RUN' : ''}\n`);
  // NSSOs with an item lacking its job order while the NSSO has job orders.
  const [rows] = await pool.query(
    `SELECT DISTINCT n.id, n.nsso_no FROM non_standard_sales_orders n
       JOIN non_standard_sales_order_lines l ON l.nsso_id = n.id AND l.created_job_order_id IS NULL
      WHERE EXISTS (SELECT 1 FROM job_orders jo WHERE jo.nsso_id = n.id)
      ORDER BY n.id`);
  let linked = 0;
  for (const n of rows) {
    const done = await relinkNsso(pool, n.id, { dryRun: DRY });
    for (const d of done) console.log(`${DRY ? '~' : '+'} ${n.nsso_no} item ${d.line_no} -> ${d.job_order_no}`);
    linked += done.length;
  }
  console.log(`\n${rows.length} NSSO(s) checked, ${linked} item(s) ${DRY ? 'would be ' : ''}linked.`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
