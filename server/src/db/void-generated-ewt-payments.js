// Void the generated CPAY-INV-#### "payments" that are really the customer's withholding tax (asked
// 2026-10-22). generate-invoice-payments.js (--missing-only, run 2026-10-09) made one payment per
// invoice for (gross - amount due); on invoices dated from October that difference was only the EWT --
// amount_due is the cash due, net of EWT -- so it booked the tax the customer WITHHELD as cash
// RECEIVED: 45 payments, PHP 53,328.22, each exactly its invoice's ewt_amount (INV-83526: CPAY-1459
// paid 7,037.89, CPAY-INV-83526 "paid" the 127.96 EWT). That money never came in; the EWT is settled
// by the customer's BIR 2307 (a credit memo to Creditable Withholding Tax), not a receipt.
//
// Voided: generated payments dated from 2026-10-01, one line, for exactly the invoice's EWT. Then the
// invoice is settled again as the app settles it -- amount_due = cash still due (gross due less EWT),
// Paid In Full reopened to Open while its EWT is outstanding. Audit-logged.
//
//   node src/db/void-generated-ewt-payments.js                    preview
//   node src/db/void-generated-ewt-payments.js --apply --by=<user id>
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { grossDueSql } = require('../lib/invoiceDue');

const APPLY = process.argv.includes('--apply');
const byArg = process.argv.find((a) => a.startsWith('--by='));
const BY = byArg ? Number(byArg.split('=')[1]) : 1;
const MARK = 'generated payment was the EWT, not cash (void-generated-ewt-payments.js)';

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- PREVIEW (add --apply to write)'}\n`);
  const [rows] = await pool.query(
    `SELECT cp.id AS payment_id, cp.customer_payment_no, cp.status, cp.date_created, cpl.applied_amount,
            si.id AS invoice_id, si.invoice_no, si.gross_amount, si.ewt_amount, si.amount_due, si.status AS inv_status
       FROM customer_payments cp
       JOIN customer_payment_lines cpl ON cpl.customer_payment_id = cp.id
       JOIN sales_invoices si ON si.id = cpl.sales_invoice_id
      WHERE cp.customer_payment_no LIKE 'CPAY-INV-%' AND cp.status <> 'voided' AND cp.date_created >= '2026-10-01'
        AND (SELECT COUNT(*) FROM customer_payment_lines x WHERE x.customer_payment_id = cp.id) = 1
        AND si.ewt_amount > 0 AND ABS(cpl.applied_amount - si.ewt_amount) < 0.01
      ORDER BY cp.date_created, cp.id`);
  let total = 0;
  for (const r of rows) {
    total += Number(r.applied_amount);
    if (!APPLY) {
      console.log(`${r.customer_payment_no}  ${r.date_created}  ${Number(r.applied_amount).toFixed(2)}  -> void   ${r.invoice_no} (${r.inv_status}, due ${Number(r.amount_due).toFixed(2)})`);
      continue;
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("UPDATE customer_payments SET status = 'voided', voided_at = NOW(), voided_by_user_id = ? WHERE id = ?", [BY, r.payment_id]);
      const [[g]] = await conn.query(`SELECT ${grossDueSql('si')} AS gdue FROM sales_invoices si WHERE si.id = ?`, [r.invoice_id]);
      const gdue = Number(g.gdue);
      const due = Math.max(0, Math.round((gdue - Number(r.ewt_amount || 0)) * 100) / 100);
      const status = gdue > 0.005 && r.inv_status === 'paid_in_full' ? 'saved' : r.inv_status;
      await conn.query('UPDATE sales_invoices SET amount_due = ?, status = ? WHERE id = ?', [due, status, r.invoice_id]);
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id) VALUES
         ('CustomerPayment', ?, 'Status Change', 'status', ?, ?, ?),
         ('SalesInvoice', ?, 'Updated', 'amount_due', ?, ?, ?)`,
        [r.payment_id, r.status, `voided -- ${MARK}`, BY,
          r.invoice_id, `${Number(r.amount_due).toFixed(2)} ${r.inv_status}`, `${due.toFixed(2)} ${status} -- ${r.customer_payment_no} ${MARK}`, BY]);
      await conn.commit();
      console.log(`${r.customer_payment_no} voided; ${r.invoice_no}: gross due ${gdue.toFixed(2)} (EWT ${Number(r.ewt_amount).toFixed(2)}), cash due ${due.toFixed(2)}, ${status}`);
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  console.log(`\n${APPLY ? 'Voided' : 'Would void'} ${rows.length} generated payment(s), ${total.toFixed(2)}.`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
