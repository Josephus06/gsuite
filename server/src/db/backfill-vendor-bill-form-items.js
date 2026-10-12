// Which Liquidation items each EARLIER liquidation Vendor Bill posts (2026-10-12). A bill raised
// before vendor_bill_form_items existed has no rows there, and lib/liquidationPosting.js reads such a
// bill as posting EVERY item of its liquidation. VB-24859 (REQ-37) posts 8 of its 13 items -- the
// other 5 were removed from the bill to go on another -- yet the liquidation read fully billed, with
// no Bill Remaining Items.
//
// Each line of such a bill is matched to an item of its liquidation with the same particulars
// (case and spacing ignored) and the same amount, each item once. Bills where no line matches are
// listed and left alone (still read as posting everything, as before).
//
//   node src/db/backfill-vendor-bill-form-items.js --dry-run
//   node src/db/backfill-vendor-bill-form-items.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${DRY_RUN ? 'DRY RUN' : 'APPLYING'}`);
  const [bills] = await pool.query(
    `SELECT vb.id, vb.bill_no, vb.form_request_id, fr.request_no
       FROM vendor_bills vb JOIN form_requests fr ON fr.id = vb.form_request_id
      WHERE vb.status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM vendor_bill_form_items x WHERE x.vendor_bill_id = vb.id)
      ORDER BY vb.id`);
  let linked = 0; const unmatched = [];
  for (const b of bills) {
    const [items] = await pool.query(
      'SELECT id, particulars, amount FROM form_request_items WHERE form_request_id = ? AND amount <> 0 ORDER BY id', [b.form_request_id]);
    const [lines] = await pool.query('SELECT description, unit_price, qty FROM vendor_bill_lines WHERE vendor_bill_id = ? ORDER BY id', [b.id]);
    const taken = new Set(); const ids = [];
    for (const l of lines) {
      const amt = Number(l.unit_price || 0) * Number(l.qty || 1);
      const it = items.find((i) => !taken.has(i.id) && norm(i.particulars) === norm(l.description) && Math.abs(Number(i.amount) - amt) < 0.005);
      if (it) { taken.add(it.id); ids.push(it.id); }
    }
    if (!ids.length) { unmatched.push(`${b.bill_no} (${b.request_no})`); continue; }
    console.log(`  ${b.bill_no} (${b.request_no}): ${ids.length} of ${items.length} item(s)${ids.length < items.length ? ` -- ${items.length - ids.length} left to bill` : ''}`);
    if (!DRY_RUN) {
      for (const id of ids) await pool.query('INSERT IGNORE INTO vendor_bill_form_items (vendor_bill_id, form_request_item_id) VALUES (?, ?)', [b.id, id]);
    }
    linked += 1;
  }
  console.log(`earlier liquidation bills ${bills.length} | ${DRY_RUN ? 'to link' : 'linked'} ${linked} | no line matched ${unmatched.length}${unmatched.length ? `: ${unmatched.join(', ')}` : ''}`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
