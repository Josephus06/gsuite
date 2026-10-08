// Link opening AP items to the vendor bills they are (2026-10-08). An opening item carries the
// source's bill number (doc_no); vendor_bill_id was filled at load time only for bills already in
// T1S. 4,127 expense bills were imported afterwards (import-expense-bills.js), so their opening
// items still pointed at nothing -- and a payment entered in T1S against such a bill would not
// reduce its opening balance (lib/openingBalances.js settles items through vendor_bill_id).
//
// Only unlinked 'Bill' items, matched on bill number, and only to a bill of the same supplier (or
// when the item names none). Safe to re-run.
//
//   node src/db/link-opening-ap-bills.js            # preview
//   node src/db/link-opening-ap-bills.js --apply
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const MATCH = `FROM opening_ap_items o
  JOIN vendor_bills vb ON vb.bill_no = o.doc_no COLLATE utf8mb4_unicode_ci
 WHERE o.doc_type = 'Bill' AND o.vendor_bill_id IS NULL
   AND (o.supplier_id IS NULL OR vb.supplier_id IS NULL OR o.supplier_id = vb.supplier_id)`;

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [rows] = await pool.query(`SELECT o.id, o.doc_no, o.balance, vb.id AS vb_id ${MATCH}`);
  const total = rows.reduce((s, r) => s + Number(r.balance || 0), 0);
  console.log(`Opening AP bill items to link: ${rows.length} (open balance ${total.toFixed(2)})`);
  if (APPLY && rows.length) {
    const [r] = await pool.query(`UPDATE opening_ap_items o
      JOIN vendor_bills vb ON vb.bill_no = o.doc_no COLLATE utf8mb4_unicode_ci
       SET o.vendor_bill_id = vb.id
     WHERE o.doc_type = 'Bill' AND o.vendor_bill_id IS NULL
       AND (o.supplier_id IS NULL OR vb.supplier_id IS NULL OR o.supplier_id = vb.supplier_id)`);
    console.log(`Linked ${r.affectedRows}.`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
