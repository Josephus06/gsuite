// Open invoices with nothing to collect -- gross and amount due both zero (a 100%-discounted order or
// JO, a zero-priced sample / RMA line) -- set to Paid in Full (asked 2026-10-26, INV-84790). New ones
// settle themselves on save (routes/salesInvoices.js settleZeroInvoice); this settles those already
// saved. Voided invoices are left alone. Audit-logged per invoice.
//
//   node src/db/settle-zero-invoices.js                  preview
//   node src/db/settle-zero-invoices.js --apply --by=1
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const BY = Number((process.argv.find((a) => a.startsWith('--by=')) || '').slice(5)) || null;

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- PREVIEW (add --apply --by=<user id> to write)'}\n`);
  if (APPLY && !BY) throw new Error('--by=<user id> is required with --apply');
  const [rows] = await pool.query(
    `SELECT id, invoice_no, date_created, discount_amount
       FROM sales_invoices
      WHERE status = 'saved' AND ABS(COALESCE(gross_amount, 0)) <= 0.005 AND ABS(COALESCE(amount_due, 0)) <= 0.005
      ORDER BY id`);
  for (const r of rows) console.log(`  ${r.invoice_no}  ${String(r.date_created).slice(0, 10)}  discount ${Number(r.discount_amount || 0).toFixed(2)}`);
  console.log(`\n${rows.length} open invoice(s) with nothing to collect${APPLY ? '' : ' would be set to Paid in Full'}.`);
  if (APPLY && rows.length) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const r of rows) {
        await conn.query("UPDATE sales_invoices SET status = 'paid_in_full' WHERE id = ? AND status = 'saved'", [r.id]);
        await conn.query(
          `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
           VALUES ('SalesInvoice', ?, 'Updated', 'status', 'Open', 'Paid in Full (nothing to collect)', ?)`, [r.id, BY]);
      }
      await conn.commit();
      console.log('Applied.');
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
