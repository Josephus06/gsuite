// Restore the full rate on migrated PO lines whose rate was cut to 4 decimals (2026-10-09, PO-20604:
// 1,000 at 0.6518 for 651.79 -- the real rate is 0.65179). The PO's own amounts are right, but a
// Receiving Report made from it in T1S priced the line at the cut rate: RR-20162 came to 730.02
// against the PO's 730.00. Rates hold 6 decimals now (widen-purchasing-rates.js).
//
//  1. PO line: rate := (net of tax + discount) / qty, to 6 decimals -- only where that is a true
//     cut-off (within 0.00005 of the stored rate) and reproduces the line's own amount exactly. A
//     line whose amount disagrees with its rate for another reason is listed, not touched.
//  2. Receipt lines on those PO lines still at the cut rate, whose PO line has no Vendor Bill line
//     yet: repriced at the full rate, each step to the centavo (Subtotal, Discount, Net, Tax, Ext.
//     Price -- as routes/purchaseOrders.js prices one), and their receipt re-totalled. Billed ones
//     are listed and left alone.
//
//   node src/db/fix-po-rate-precision.js            # preview
//   node src/db/fix-po-rate-precision.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const cents = (n) => Math.round(Number((Number(n) * 100).toFixed(6))) / 100;

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [lines] = await pool.query(
    `SELECT pol.id, pol.qty, pol.rate, pol.disc_amount, pol.net_of_tax, po.po_no
       FROM purchase_order_lines pol JOIN purchase_orders po ON po.id = pol.purchase_order_id WHERE pol.qty > 0`);
  const fix = new Map(); let other = 0;
  for (const l of lines) {
    const gross = cents(Number(l.net_of_tax) + Number(l.disc_amount || 0));
    if (Math.abs(cents(Number(l.qty) * Number(l.rate)) - gross) < 0.005) continue;
    const newRate = Math.round((gross / Number(l.qty)) * 1e6) / 1e6;
    if (Math.abs(newRate - Number(l.rate)) < 0.00005 && Math.abs(cents(Number(l.qty) * newRate) - gross) < 0.005) {
      fix.set(Number(l.id), { ...l, newRate });
    } else other += 1;
  }
  console.log(`PO lines with a cut rate: ${fix.size} (restored to 6 decimals) | amount disagrees with rate for another reason: ${other} (left alone)`);
  [...fix.values()].slice(0, 5).forEach((l) => console.log(`  ${l.po_no} line ${l.id}: ${l.rate} -> ${l.newRate}`));

  const ids = [...fix.keys()];
  const [rl] = ids.length ? await pool.query(
    `SELECT rl.*, r.receipt_no, t.rate AS tax_rate, pol.qty AS po_qty, pol.ext_price AS po_ext,
            EXISTS (SELECT 1 FROM vendor_bill_lines vbl WHERE vbl.purchase_order_line_id = rl.purchase_order_line_id) AS billed
       FROM purchase_order_receipt_lines rl
       JOIN purchase_order_receipts r ON r.id = rl.purchase_order_receipt_id
       JOIN purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
       LEFT JOIN taxes t ON t.id = rl.tax_code_id
      WHERE rl.purchase_order_line_id IN (?)`, [ids]) : [[]];
  const atCut = rl.filter((r) => Math.abs(Number(r.rate) - Number(fix.get(Number(r.purchase_order_line_id)).rate)) < 1e-9);
  const reprice = atCut.filter((r) => !Number(r.billed));
  const billed = atCut.filter((r) => Number(r.billed));
  let changes = reprice.map((r) => {
    const rate = fix.get(Number(r.purchase_order_line_id)).newRate;
    const sub = cents(Number(r.qty_received) * rate);
    const disc = cents(sub * (Number(r.disc_percent || 0) / 100));
    const net = cents(sub - disc);
    // A line with no tax code (migrated) keeps the rate it was taxed at: its own tax / net.
    const taxPct = r.tax_rate != null ? Number(r.tax_rate)
      : (Number(r.net_of_tax) ? (Number(r.tax_amount) / Number(r.net_of_tax)) * 100 : 0);
    const tax = cents(net * (taxPct / 100));
    return { r, rate, disc, net, tax, ext: cents(net + tax) };
  }).filter((c) => Math.abs(c.ext - Number(c.r.ext_price)) >= 0.005 || Math.abs(c.net - Number(c.r.net_of_tax)) >= 0.005);
  // Only where it brings the receipt INTO line with its PO: the receipt line differs from the PO
  // line's amount (pro-rated for the qty received) today, and the repriced one matches it. A receipt
  // that already agrees with its PO (RR-18462) is left exactly as it is.
  const expectedOf = (r) => cents(Number(r.po_ext) * (Number(r.qty_received) / Number(r.po_qty)));
  const notNeeded = changes.filter((c) => Math.abs(Number(c.r.ext_price) - expectedOf(c.r)) < 0.005 || Math.abs(c.ext - expectedOf(c.r)) >= 0.005);
  changes = changes.filter((c) => !notNeeded.includes(c));
  if (notNeeded.length) console.log(`  already match their PO (or would not), left alone: ${notNeeded.map((c) => c.r.receipt_no).join(', ')}`);
  console.log(`receipt lines at the cut rate: ${atCut.length} | repriced (not billed, amount moves): ${changes.length} | billed, left alone: ${billed.length}`);
  changes.slice(0, 8).forEach((c) => console.log(`  ${c.r.receipt_no}: ${c.r.ext_price} -> ${c.ext}`));
  if (billed.length) console.log(`  billed: ${[...new Set(billed.map((b) => b.receipt_no))].slice(0, 10).join(', ')}`);

  if (APPLY) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const l of fix.values()) await conn.query('UPDATE purchase_order_lines SET rate = ? WHERE id = ?', [l.newRate, l.id]);
      const receipts = new Set();
      for (const c of changes) {
        await conn.query(
          'UPDATE purchase_order_receipt_lines SET rate = ?, disc_amount = ?, net_of_tax = ?, tax_amount = ?, ext_price = ? WHERE id = ?',
          [c.rate, c.disc, c.net, c.tax, c.ext, c.r.id]);
        receipts.add(c.r.purchase_order_receipt_id);
      }
      for (const id of receipts) {
        await conn.query(
          `UPDATE purchase_order_receipts r JOIN (
             SELECT purchase_order_receipt_id AS rid, ROUND(SUM(net_of_tax + disc_amount), 2) AS sub, ROUND(SUM(disc_amount), 2) AS disc,
                    ROUND(SUM(net_of_tax), 2) AS net, ROUND(SUM(tax_amount), 2) AS tax, ROUND(SUM(ext_price), 2) AS total
               FROM purchase_order_receipt_lines WHERE purchase_order_receipt_id = ? GROUP BY purchase_order_receipt_id) s ON s.rid = r.id
             SET r.subtotal = s.sub, r.discount_amount = s.disc, r.net_of_tax = s.net, r.tax_amount = s.tax, r.total_amount = s.total`, [id]);
      }
      await conn.commit();
      console.log(`restored ${fix.size} PO line rate(s); repriced ${changes.length} receipt line(s) on ${receipts.size} receipt(s).`);
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
