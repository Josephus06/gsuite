// READ-ONLY unless --apply. Puts every invoice under its order's office (asked 2026-11-17: "the
// invoice office location should be the same office location of its Sales Order").
//
// An invoice billed from a Sales Order takes the Sales Order's Office Location; one billed from a
// Non-Standard Sales Order, the NSSO's. Orders with no office are left alone, and so are invoices
// with no order (estimate / standalone). On 2026-11-17 the cloud had 41,932 SO invoices listed under
// Head Office while their order sat at Branch - Ayala (25,014) or Branch - SM (16,918) -- almost all
// from the source import, plus 10 raised in T1S in October 2026 (INV-83565 ...) -- and 2 NSSO ones.
//
//   node src/db/fix-invoice-office-from-order.js            # counts, by office, and a sample
//   node src/db/fix-invoice-office-from-order.js --apply    # sets them
//
// Run it once on the cloud: the UPDATE replicates to the office and SM servers. Railway has its own
// database and needs its own run. Only sales_invoices.office_location_id changes.
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');

const PARENTS = [
  { label: 'Sales Order', join: 'JOIN sales_orders p ON p.id = si.sales_order_id' },
  { label: 'NSSO', join: 'JOIN non_standard_sales_orders p ON p.id = si.nsso_id' },
];
const MISMATCH = 'p.office_location_id IS NOT NULL AND NOT (si.office_location_id <=> p.office_location_id)';

async function main() {
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} -- DB ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);
  let total = 0;
  for (const { label, join } of PARENTS) {
    const [groups] = await pool.query(
      `SELECT il.location_name AS invoice_office, pl.location_name AS order_office, COUNT(*) AS n,
              MIN(si.date_created) AS first, MAX(si.date_created) AS last
         FROM sales_invoices si ${join}
         LEFT JOIN locations il ON il.id = si.office_location_id
         LEFT JOIN locations pl ON pl.id = p.office_location_id
        WHERE ${MISMATCH}
        GROUP BY il.location_name, pl.location_name ORDER BY n DESC`);
    const n = groups.reduce((s, g) => s + Number(g.n), 0);
    total += n;
    console.log(`${label} invoices under a different office from their order: ${n}`);
    for (const g of groups) {
      console.log(`  ${String(g.n).padStart(7)}  ${g.invoice_office || '(none)'}  ->  ${g.order_office}   (${String(g.first).slice(0, 10)} .. ${String(g.last).slice(0, 10)})`);
    }
    if (!n) { console.log(''); continue; }
    const [sample] = await pool.query(
      `SELECT si.invoice_no FROM sales_invoices si ${join} WHERE ${MISMATCH} ORDER BY si.id DESC LIMIT 8`);
    console.log(`  e.g. ${sample.map((r) => r.invoice_no).join(', ')}\n`);
    if (APPLY) {
      const [r] = await pool.query(
        `UPDATE sales_invoices si ${join} SET si.office_location_id = p.office_location_id WHERE ${MISMATCH}`);
      console.log(`  APPLIED: ${r.affectedRows} ${label} invoice(s) moved to their order's office.\n`);
    }
  }
  if (!APPLY) console.log(`DRY RUN -- ${total} invoice(s) would move. Re-run with --apply to set them.`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
