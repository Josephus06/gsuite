// Sales Orders generated from an estimate before 2026-10-05 had their Tax / Total worked as each
// line's Net x rate UNROUNDED and summed, so an order could read a centavo off its estimate
// (EST-105221: 2,850.00 -> 2,850.01). This puts their header back on the sum of the lines' own
// 2-decimal figures, as the generator now does. Only orders made in T1S (created since go-live) whose
// total moves by less than a peso are touched -- anything bigger is a real difference, not rounding.
//
//   node src/db/fix-so-totals-centavo.js            # preview
//   node src/db/fix-so-totals-centavo.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [orders] = await pool.query(
    `SELECT so.id, so.sales_order_no, so.tax_total, so.total_amount,
            SUM(sol.subtotal) AS sub, SUM(sol.disc_amount) AS disc, SUM(sol.tax_amount) AS tax
       FROM sales_orders so JOIN sales_order_lines sol ON sol.sales_order_id = so.id
      WHERE so.estimate_id IS NOT NULL AND so.created_at >= '2026-09-28'
      GROUP BY so.id`
  );
  let changed = 0;
  for (const o of orders) {
    const subtotal = r2(o.sub);
    const discount = r2(o.disc);
    const net = r2(subtotal - discount);
    const tax = r2(o.tax);
    const total = r2(net + tax);
    const diff = r2(total - Number(o.total_amount));
    if (diff === 0 || Math.abs(diff) >= 1) continue;
    changed += 1;
    console.log(`  ${o.sales_order_no}: total ${Number(o.total_amount).toFixed(2)} -> ${total.toFixed(2)} (tax ${Number(o.tax_total).toFixed(2)} -> ${tax.toFixed(2)})`);
    if (APPLY) {
      await pool.query(
        'UPDATE sales_orders SET subtotal = ?, discount_total = ?, net_of_tax = ?, tax_total = ?, total_amount = ? WHERE id = ?',
        [subtotal, discount, net, tax, total, o.id]
      );
    }
  }
  console.log(`${orders.length} order(s) checked, ${changed} ${APPLY ? 'corrected' : 'would change'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
