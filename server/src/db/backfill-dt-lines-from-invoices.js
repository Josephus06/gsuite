// Delivery Tickets imported with NO item lines -- 5,918 of 6,088 (2026-10-01). The importer could
// read lines only for OPEN tickets: once a DT is CONVERTED the source's get_invoice(pk) answers with
// the invoice, so converted DTs came across as headers only.
//
// A converted DT's items ARE its invoice's items (that is what conversion is), and T1S holds that
// invoice with its lines (sales_invoices.delivery_ticket_id). This copies them onto the DT -- only
// where the invoice's gross equals the DT's within 1.00, so a partly-billed or edited invoice is
// never passed off as the ticket. Display only: a converted DT posts nothing (its invoice does).
//
//   node src/db/backfill-dt-lines-from-invoices.js            preview
//   node src/db/backfill-dt-lines-from-invoices.js --apply
// Droplet and office replicate: run on ONE box (droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLY' : 'PREVIEW'}`);
  const [pairs] = await pool.query(
    `SELECT d.id dt_id, d.dt_no, d.gross_amount dt_gross, si.id si_id, si.invoice_no, si.gross_amount si_gross
       FROM delivery_tickets d
       JOIN sales_invoices si ON si.delivery_ticket_id = d.id AND si.status <> 'cancelled'
      WHERE d.status = 'converted'
        AND NOT EXISTS (SELECT 1 FROM delivery_ticket_lines l WHERE l.delivery_ticket_id = d.id)
        AND EXISTS (SELECT 1 FROM sales_invoice_lines sl WHERE sl.sales_invoice_id = si.id)`);
  // One invoice per DT; if a DT somehow has two, skip it rather than guess.
  const byDt = new Map();
  for (const p of pairs) byDt.set(p.dt_id, byDt.has(p.dt_id) ? null : p);
  const usable = [...byDt.values()].filter((p) => p && Math.abs(Number(p.dt_gross || 0) - Number(p.si_gross || 0)) <= 1.0);
  const mismatched = [...byDt.values()].filter((p) => p && Math.abs(Number(p.dt_gross || 0) - Number(p.si_gross || 0)) > 1.0);
  const multi = [...byDt.values()].filter((p) => p === null).length;
  console.log(`converted DTs with no lines but an invoice with lines: ${byDt.size}; gross matches: ${usable.length}; gross differs: ${mismatched.length}; >1 invoice: ${multi}`);
  if (mismatched.length) console.log('  e.g. differs:', mismatched.slice(0, 5).map((m) => `${m.dt_no} ${m.dt_gross} vs ${m.invoice_no} ${m.si_gross}`).join(' | '));
  if (!APPLY) { await pool.end(); return; }

  const conn = await pool.getConnection();
  let lines = 0;
  try {
    await conn.beginTransaction();
    for (const p of usable) {
      const [r] = await conn.query(
        `INSERT INTO delivery_ticket_lines
           (delivery_ticket_id, line_no, sales_order_line_id, job_order_id, item_id, item_name, description, location_id,
            quantity, units, unit_title, price_per_unit, subtotal, disc_percent, disc_per_unit, disc_amount, disc_price_per_unit,
            net_of_tax, tax_code, tax_amount, gross_amount)
         SELECT ?, ROW_NUMBER() OVER (ORDER BY sl.id), sl.sales_order_line_id, sl.job_order_id, NULL, jt.display_name, sl.description,
                sl.job_location_id, sl.quantity, sl.units, sl.units, sl.price_per_unit, sl.subtotal, sl.disc_percent,
                CASE WHEN sl.quantity THEN ROUND(sl.disc_amount / sl.quantity, 4) ELSE 0 END, sl.disc_amount, sl.disc_price_per_unit,
                sl.net_of_tax, sl.tax_code, sl.tax_amount, sl.gross_amount
           FROM sales_invoice_lines sl LEFT JOIN job_types jt ON jt.id = sl.job_type_id
          WHERE sl.sales_invoice_id = ?
            AND NOT EXISTS (SELECT 1 FROM delivery_ticket_lines x WHERE x.delivery_ticket_id = ?)`,
        [p.dt_id, p.si_id, p.dt_id]);
      lines += r.affectedRows;
    }
    await conn.commit();
    console.log(`Committed: ${usable.length} DT(s) given ${lines} line(s) from their invoices.`);
  } catch (e) { await conn.rollback(); console.error('FAILED (rolled back):', e.message); process.exitCode = 1; } finally { conn.release(); }
  await pool.end();
})();
