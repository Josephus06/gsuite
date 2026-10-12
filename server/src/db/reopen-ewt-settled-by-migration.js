// Reopen the withheld EWT that a migration settlement marked paid (2026-10-12). A customer pays an
// invoice net of EWT and the EWT is cleared later by its EWT credit memo (BIR 2307) -- on GROSS the
// EWT stays due until then (lib/invoiceDue.js). generate-invoice-payments.js wrote a CPAY-INV-<no>
// settlement for what the source counted as paid, and the source counts withheld EWT as paid:
// INV-82506 (gross 6,238.40, EWT 111.40) got CPAY-INV-82506 for exactly 111.40 beside the customer's
// real 6,127.00 (CPAY-433), so it read nothing due and its EWT credit memo had nothing to apply to.
//
// Removes such a settlement only when ALL hold:
//   - it is the script's CPAY-INV-<invoice no>, no user behind it, applied to that one invoice only;
//   - it applies exactly the invoice's EWT;
//   - the invoice has another payment or credit memo (not voided) -- the real money.
// A settlement for a whole invoice, EWT included, is NOT touched. The invoice's cash balance
// (amount_due) and status do not change: only its gross Amount Due goes back up by the EWT.
//
//   node src/db/reopen-ewt-settled-by-migration.js --dry-run
//   node src/db/reopen-ewt-settled-by-migration.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${DRY_RUN ? 'DRY RUN' : 'APPLYING'}`);
  const [rows] = await pool.query(
    `SELECT cp.id AS payment_id, cp.customer_payment_no, cp.date_created, si.id AS invoice_id, si.invoice_no, si.ewt_amount, cpl.applied_amount
       FROM customer_payments cp
       JOIN customer_payment_lines cpl ON cpl.customer_payment_id = cp.id
       JOIN sales_invoices si ON si.id = cpl.sales_invoice_id
      WHERE cp.customer_payment_no LIKE 'CPAY-INV-%' AND cp.customer_payment_no = CONCAT('CPAY-', si.invoice_no)
        AND cp.created_by_user_id IS NULL AND cp.status <> 'voided' AND si.status <> 'cancelled'
        AND COALESCE(si.ewt_amount, 0) > 0 AND ABS(cpl.applied_amount - si.ewt_amount) < 0.005
        AND (SELECT COUNT(*) FROM customer_payment_lines x WHERE x.customer_payment_id = cp.id) = 1
        AND (EXISTS (SELECT 1 FROM customer_payment_lines o JOIN customer_payments op ON op.id = o.customer_payment_id
                      WHERE o.sales_invoice_id = si.id AND op.id <> cp.id AND op.status <> 'voided')
             OR EXISTS (SELECT 1 FROM credit_memo_applications a JOIN credit_memos cm ON cm.id = a.credit_memo_id
                         WHERE a.sales_invoice_id = si.id AND cm.status <> 'voided'))
      ORDER BY si.id`);
  const total = rows.reduce((s, r) => s + Number(r.applied_amount), 0);
  const byYear = {};
  rows.forEach((r) => { const y = String(r.date_created).slice(0, 4); byYear[y] = (byYear[y] || 0) + 1; });
  console.log(`EWT-only migration settlements to remove: ${rows.length}, EWT reopened ${total.toFixed(2)}`);
  console.log('  by settlement year:', JSON.stringify(byYear));
  rows.slice(0, 10).forEach((r) => console.log(`  ${r.customer_payment_no}: ${Number(r.applied_amount).toFixed(2)} EWT back on ${r.invoice_no}`));
  if (!DRY_RUN && rows.length) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const r of rows) {
        await conn.query('DELETE FROM customer_payment_lines WHERE customer_payment_id = ?', [r.payment_id]);
        await conn.query('DELETE FROM customer_payments WHERE id = ?', [r.payment_id]);
      }
      await conn.commit();
      console.log(`Removed ${rows.length} settlement(s).`);
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
