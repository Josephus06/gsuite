// Make every PO's Net of Tax + Tax equal its Total (asked 2026-10-08, PO-20586: 28,828.12 + 3,459.37
// shown against a 32,287.50 total). The Total is the gross the supplier bills and is kept; the Tax
// absorbs the rounding centavo: Tax = Total - Net of Tax -- the rule the PO routes now apply to new
// and edited lines. On the header and on each line (Ext. Price - Net of Tax).
//
// Only differences of up to 5 centavos are rounding; anything larger is a different problem and is
// listed, not touched.
//
//   node src/db/fix-po-tax-rounding.js            # preview
//   node src/db/fix-po-tax-rounding.js --apply
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const OFF = 'ROUND(net_of_tax + tax_amount, 2) <> ROUND(total_amount, 2)';
const SMALL = 'ABS(ROUND(net_of_tax + tax_amount - total_amount, 2)) <= 0.05';

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [pos] = await pool.query(`SELECT id, po_no, net_of_tax, tax_amount, total_amount FROM purchase_orders WHERE ${OFF} AND ${SMALL} ORDER BY id`);
  const [big] = await pool.query(`SELECT po_no, net_of_tax, tax_amount, total_amount FROM purchase_orders WHERE ${OFF} AND NOT (${SMALL})`);
  const [lines] = await pool.query(
    `SELECT l.id, l.purchase_order_id, l.net_of_tax, l.tax_amount, l.ext_price FROM purchase_order_lines l
      WHERE ROUND(l.net_of_tax + l.tax_amount, 2) <> ROUND(l.ext_price, 2)
        AND ABS(ROUND(l.net_of_tax + l.tax_amount - l.ext_price, 2)) <= 0.05`);
  for (const p of pos.slice(0, 10)) {
    console.log(`  ${p.po_no}: Tax ${Number(p.tax_amount).toFixed(2)} -> ${(Number(p.total_amount) - Number(p.net_of_tax)).toFixed(2)} (Net ${p.net_of_tax}, Total ${p.total_amount})`);
  }
  if (pos.length > 10) console.log(`  ... and ${pos.length - 10} more`);
  for (const b of big) console.log(`  LEFT (off by more than 5 centavos): ${b.po_no} Net ${b.net_of_tax} + Tax ${b.tax_amount} vs Total ${b.total_amount}`);

  if (APPLY) {
    const [[admin]] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' ORDER BY id LIMIT 1");
    for (const p of pos) {
      const tax = Math.round((Number(p.total_amount) - Number(p.net_of_tax)) * 100) / 100;
      await pool.query('UPDATE purchase_orders SET tax_amount = ? WHERE id = ?', [tax, p.id]);
      await pool.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('PurchaseOrder', ?, 'Updated', 'tax_amount (rounding: Total - Net)', ?, ?, ?)`,
        [p.id, String(Number(p.tax_amount)), String(tax), admin.id]);
    }
    for (const l of lines) {
      await pool.query('UPDATE purchase_order_lines SET tax_amount = ROUND(ext_price - net_of_tax, 2) WHERE id = ?', [l.id]);
    }
  }
  console.log(`${APPLY ? 'Fixed' : 'Would fix'} ${pos.length} PO header(s) and ${lines.length} line(s); left ${big.length} with a larger difference.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
