// Fill a Sales Order line's Job Location from its Job Order (2026-10-24).
//
// SO-55598 showed a blank Job Location on both lines where the source shows "Warehouse - SIGN":
// import-sales.js never wrote sales_order_lines.job_location_id, and backfill-so-header-details.js
// --lines was run for 2026 orders only. The JO already carries the source's location
// (import-jo-processes.js), so the line takes it from there -- local SQL, no source calls.
//
// FILL-ONLY: only lines whose location is still empty. Re-runnable.
//
//   node src/db/backfill-so-line-location-from-jo.js           # dry run
//   node src/db/backfill-so-line-location-from-jo.js --apply
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- DRY RUN'}`);
  const [[n]] = await pool.query(
    `SELECT COUNT(*) AS n FROM sales_order_lines sol JOIN job_orders jo ON jo.id = sol.job_order_id
      WHERE sol.job_location_id IS NULL AND jo.job_location_id IS NOT NULL`);
  console.log(`  ${n.n} line(s) without a Job Location whose JO has one`);
  if (APPLY && n.n) {
    let total = 0;
    // In batches, so replication and the live app never wait on one huge transaction.
    for (;;) {
      const [r] = await pool.query(
        `UPDATE sales_order_lines sol JOIN (
           SELECT sol2.id, jo.job_location_id FROM sales_order_lines sol2 JOIN job_orders jo ON jo.id = sol2.job_order_id
            WHERE sol2.job_location_id IS NULL AND jo.job_location_id IS NOT NULL LIMIT 5000) x ON x.id = sol.id
           SET sol.job_location_id = x.job_location_id`);
      if (!r.affectedRows) break;
      total += r.affectedRows;
      console.log(`  ...${total}`);
    }
    console.log(`  filled ${total}`);
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
