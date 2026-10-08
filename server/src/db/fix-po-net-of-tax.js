// Purchase Orders whose header Net of Tax ignores the discount (2026-10-08, PO-20099: Subtotal
// 9,392.86, Discount 469.64, Net of Tax 9,392.86 -- should be 8,923.21). Migrated POs carry the
// source's header as it was; their lines are right. 1,665 of the 1,674 POs with a discount.
//
// The header Net of Tax is set to the sum of its lines' Net of Tax -- only where that sum, plus the
// header's own tax, comes to the header's Total Amount (within a peso), so the fix agrees with the
// figures already on the PO. Anything that does not add up is listed and left alone.
//
//   node src/db/fix-po-net-of-tax.js            # preview
//   node src/db/fix-po-net-of-tax.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [rows] = await pool.query(
    `SELECT po.id, po.po_no, po.subtotal, po.discount_amount, po.net_of_tax, po.tax_amount, po.total_amount,
            ROUND(SUM(pol.net_of_tax), 2) AS lines_net
       FROM purchase_orders po JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
      WHERE po.discount_amount > 0 AND ABS(po.net_of_tax - (po.subtotal - po.discount_amount)) > 0.05
      GROUP BY po.id ORDER BY po.id`);
  const fix = rows.filter((r) => Math.abs(Number(r.lines_net) + Number(r.tax_amount) - Number(r.total_amount)) <= 1);
  const odd = rows.filter((r) => !fix.includes(r));
  console.log(`POs whose Net of Tax ignores the discount: ${rows.length} | fixable from their lines: ${fix.length} | left alone: ${odd.length}`);
  for (const r of fix.slice(0, 5)) console.log(`  ${r.po_no}: Net of Tax ${r.net_of_tax} -> ${r.lines_net} (Subtotal ${r.subtotal} - Discount ${r.discount_amount})`);
  for (const r of odd.slice(0, 10)) console.log(`  left alone ${r.po_no}: lines net ${r.lines_net} + tax ${r.tax_amount} != total ${r.total_amount}`);
  if (APPLY && fix.length) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const r of fix) {
        await conn.query('UPDATE purchase_orders SET net_of_tax = ? WHERE id = ?', [r.lines_net, r.id]);
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    console.log(`fixed ${fix.length} PO(s).`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
