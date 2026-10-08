// Record the customer an invoice was BILLED to, where it differs from its Sales Order's customer
// (asked 2026-10-08). INV-81555..81558 are billed to Filinvest Hospitality Corporation in the source
// (its AR aging), but carry no customer of their own, and their Sales Orders belong to Mactan
// Seascapes Services Inc. -- so the Collection Forecast filed them under Mactan Seascapes while AR
// Aging showed them under Filinvest.
//
// Source of truth: the source system's open-item snapshot (opening_ar_items, latest as_of), which
// names the customer each open invoice is owed by. Only invoices whose resolved customer
// (invoice's own, else its Sales Order's) differs from that are touched, and each change is audited
// on the invoice.
//
//   node src/db/set-invoice-billed-customer.js            # preview
//   node src/db/set-invoice-billed-customer.js --apply
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const BY = Number((process.argv.find((a) => a.startsWith('--by=')) || '').split('=')[1]) || 1;

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [rows] = await pool.query(
    `SELECT si.id, si.invoice_no, si.customer_id AS own_id, so.sales_order_no,
            COALESCE(si.customer_id, so.customer_id) AS resolved_id, rc.name AS resolved_name,
            o.customer_id AS billed_id, bc.name AS billed_name, o.balance
       FROM opening_ar_items o
       JOIN sales_invoices si ON si.id = o.sales_invoice_id
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN customers rc ON rc.id = COALESCE(si.customer_id, so.customer_id)
       LEFT JOIN customers bc ON bc.id = o.customer_id
      WHERE o.as_of = (SELECT MAX(as_of) FROM opening_ar_items)
        AND o.customer_id IS NOT NULL
        AND NOT (COALESCE(si.customer_id, so.customer_id) <=> o.customer_id)
      ORDER BY si.invoice_no`);
  let total = 0;
  for (const r of rows) {
    total += Number(r.balance || 0);
    console.log(`  ${r.invoice_no} (${r.sales_order_no || 'no SO'}): ${r.resolved_name || '—'} -> ${r.billed_name}  [open ${Number(r.balance).toFixed(2)}]`);
    if (!APPLY) continue;
    await pool.query('UPDATE sales_invoices SET customer_id = ? WHERE id = ?', [r.billed_id, r.id]);
    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('SalesInvoice', ?, 'Updated', 'customer_id', ?, ?, ?)`,
      [r.id, r.resolved_name || null, `${r.billed_name} (billed-to, from the source AR)`, BY]);
  }
  console.log(`${APPLY ? 'Updated' : 'Would update'} ${rows.length} invoice(s), open ${total.toFixed(2)}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
