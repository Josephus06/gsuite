// Point every converted estimate at its Sales Order. The migration set sales_orders.estimate_id but
// never estimates.sales_order_id -- ~70,800 estimates (2026-10-08, EST-107678 / SO-71152). The
// estimate page now finds the order either way, but the column still matters: approving an estimate
// with no sales_order_id makes a NEW Sales Order (routes/estimates.js), so an unlinked converted
// estimate is one status change away from a duplicate order.
//
// Only estimates named by exactly ONE Sales Order are linked. Those named by several are listed
// and left alone -- which one is "the" order is a decision, not a lookup.
//
//   node src/db/backfill-estimate-sales-order-link.js            # preview
//   node src/db/backfill-estimate-sales-order-link.js --apply
// Safe to re-run. Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [[single]] = await pool.query(
    `SELECT COUNT(*) n FROM (
       SELECT so.estimate_id FROM sales_orders so JOIN estimates e ON e.id = so.estimate_id
        WHERE e.sales_order_id IS NULL GROUP BY so.estimate_id HAVING COUNT(*) = 1) x`);
  const [multi] = await pool.query(
    `SELECT e.estimate_no, GROUP_CONCAT(CONCAT(so.sales_order_no, ' (', so.status, ')') ORDER BY so.id SEPARATOR ', ') AS orders
       FROM sales_orders so JOIN estimates e ON e.id = so.estimate_id
      WHERE e.sales_order_id IS NULL
      GROUP BY e.id HAVING COUNT(*) > 1 ORDER BY e.id`);
  console.log(`estimates named by exactly one Sales Order, not linked back: ${single.n}`);
  console.log(`estimates named by several Sales Orders (left alone): ${multi.length}`);
  for (const m of multi.slice(0, 15)) console.log(`   ${m.estimate_no}: ${m.orders}`);
  if (multi.length > 15) console.log(`   ... and ${multi.length - 15} more`);

  if (APPLY && Number(single.n)) {
    const [r] = await pool.query(
      `UPDATE estimates e
         JOIN (SELECT estimate_id, MIN(id) AS so_id FROM sales_orders
                WHERE estimate_id IS NOT NULL GROUP BY estimate_id HAVING COUNT(*) = 1) one
           ON one.estimate_id = e.id
          SET e.sales_order_id = one.so_id
        WHERE e.sales_order_id IS NULL`);
    console.log(`linked ${r.affectedRows} estimate(s).`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
