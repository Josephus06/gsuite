// PO lines whose Tax Amt / Ext. Price disagree with their own tax code (asked 2026-11-07, PO-20583:
// line VATPH_0 but Tax Amt 5,280.00 and Ext. Price 49,280.00, header Tax 0.00 / Total 44,000.00).
//
// How it happens: the PO was migrated while live had it at 12%; live later changed it to 0-VAT.
// lib/liveStatusSync.js refreshes a PO's HEADER totals from live on every run but never its lines,
// and backfill-po-line-item-location-department.js later set the line's tax CODE from live without
// touching the amounts. So the header and code are right, the line amounts are stale.
//
// Receiving is not affected (the receipt route re-prices from the tax code), but the PO line shows
// and sums wrong.
//
// Fix, per line with a tax code: Tax := Net of Tax x rate (to the centavo), Ext. Price := Net + Tax.
// Only on POs where the repaired lines then add up to the header's Total Amount (within a peso) --
// so the repair agrees with the figures already on the PO. Any other PO is listed and left alone.
//
//   node src/db/fix-po-line-tax-vs-code.js            preview
//   node src/db/fix-po-line-tax-vs-code.js --apply
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const cents = (n) => Math.round(Number(n) * 100) / 100;

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}\n`);
  // Lines whose stored tax is more than 5 centavos off what their code's rate gives.
  const [bad] = await pool.query(
    `SELECT l.id, l.purchase_order_id, po.po_no, po.date_created, po.total_amount AS po_total, t.code, t.rate,
            l.net_of_tax, l.tax_amount, l.ext_price
       FROM purchase_order_lines l
       JOIN purchase_orders po ON po.id = l.purchase_order_id
       JOIN taxes t ON t.id = l.tax_code_id
      WHERE ABS(l.tax_amount - ROUND(l.net_of_tax * t.rate / 100, 2)) > 0.05
      ORDER BY po.id, l.id`);
  if (!bad.length) { console.log('No PO line disagrees with its tax code.'); await pool.end(); return; }

  const poIds = [...new Set(bad.map((b) => b.purchase_order_id))];
  // Every line of those POs, so the header check counts the lines that were already right too.
  const [all] = await pool.query(
    `SELECT l.id, l.purchase_order_id, l.net_of_tax, l.tax_amount, l.ext_price FROM purchase_order_lines l WHERE l.purchase_order_id IN (?)`, [poIds]);
  const fixById = new Map(bad.map((b) => {
    const tax = cents(Number(b.net_of_tax) * Number(b.rate) / 100);
    return [b.id, { tax, ext: cents(Number(b.net_of_tax) + tax) }];
  }));

  const fix = []; const left = [];
  for (const id of poIds) {
    const lines = bad.filter((b) => b.purchase_order_id === id);
    const sum = all.filter((l) => l.purchase_order_id === id)
      .reduce((s, l) => s + (fixById.has(l.id) ? fixById.get(l.id).ext : Number(l.ext_price)), 0);
    (Math.abs(sum - Number(lines[0].po_total)) <= 1 ? fix : left).push({ lines, sum });
  }

  for (const { lines } of fix.slice(0, 15)) {
    for (const b of lines) {
      const f = fixById.get(b.id);
      console.log(`  ${b.po_no} (${String(b.date_created).slice(0, 10)}) ${b.code}: Tax ${Number(b.tax_amount).toFixed(2)} -> ${f.tax.toFixed(2)}, Ext. Price ${Number(b.ext_price).toFixed(2)} -> ${f.ext.toFixed(2)}  (header total ${Number(b.po_total).toFixed(2)})`);
    }
  }
  if (fix.length > 15) console.log(`  ... and ${fix.length - 15} more PO(s)`);
  for (const { lines, sum } of left.slice(0, 20)) {
    console.log(`  LEFT ${lines[0].po_no}: repaired lines would total ${sum.toFixed(2)}, header says ${Number(lines[0].po_total).toFixed(2)}`);
  }
  if (left.length > 20) console.log(`  ... and ${left.length - 20} more left`);

  if (APPLY) {
    const [[admin]] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' ORDER BY id LIMIT 1");
    for (const { lines } of fix) {
      for (const b of lines) {
        const f = fixById.get(b.id);
        await pool.query('UPDATE purchase_order_lines SET tax_amount = ?, ext_price = ? WHERE id = ?', [f.tax, f.ext, b.id]);
        await pool.query(
          `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
           VALUES ('PurchaseOrder', ?, 'Updated', ?, ?, ?, ?)`,
          [b.purchase_order_id, `line ${b.id} tax/ext from its tax code ${b.code}`, `${Number(b.tax_amount).toFixed(2)} / ${Number(b.ext_price).toFixed(2)}`,
           `${f.tax.toFixed(2)} / ${f.ext.toFixed(2)}`, admin ? admin.id : null]);
      }
    }
  }
  const nLines = fix.reduce((s, f) => s + f.lines.length, 0);
  console.log(`\n${APPLY ? 'Fixed' : 'Would fix'} ${nLines} line(s) on ${fix.length} PO(s); left ${left.length} PO(s) whose header does not agree.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
