// Sales Orders whose stored totals still count a line whose Job Order is Cancelled (2026-10-19,
// SO-70642). Cancelling a line's JO now takes its amount off the order (routes/salesOrders.js
// recomputeSoTotals); this corrects the orders cancelled before that. A whole cancelled Sales Order is
// left as it is.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/recompute-so-totals-cancelled-lines.js --dry-run
//   node src/db/recompute-so-totals-cancelled-lines.js
require('dotenv').config();
const pool = require('../db');
const { recomputeSoTotals } = require('../routes/salesOrders');

const DRY = process.argv.includes('--dry-run');
const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY ? ' -- DRY RUN' : ''}\n`);
  const [rows] = await pool.query(
    `SELECT so.id, so.sales_order_no, so.total_amount,
            ROUND(COALESCE(SUM(CASE WHEN jo.id IS NULL OR jo.status <> 'Cancelled' THEN sol.gross_amount END), 0), 2) AS live_total
       FROM sales_orders so
       JOIN sales_order_lines sol ON sol.sales_order_id = so.id
       LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
      WHERE so.status <> 'cancelled'
        AND EXISTS (SELECT 1 FROM sales_order_lines l2 JOIN job_orders j2 ON j2.id = l2.job_order_id
                     WHERE l2.sales_order_id = so.id AND j2.status = 'Cancelled')
      GROUP BY so.id
     HAVING ABS(so.total_amount - live_total) > 0.005
      ORDER BY so.id`);
  let off = 0;
  for (const r of rows) {
    off += Number(r.total_amount) - Number(r.live_total);
    if (rows.length <= 40 || DRY) console.log(`  ${r.sales_order_no}: ${money(r.total_amount)} -> ${money(r.live_total)}`);
    if (!DRY) await recomputeSoTotals(pool, r.id, null);
  }
  console.log(`\n${DRY ? 'Would correct' : 'Corrected'} ${rows.length} Sales Order(s); ${money(off)} of cancelled lines ${DRY ? 'would come' : 'came'} off their totals.`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
