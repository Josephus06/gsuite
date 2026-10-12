// Reopen the withheld EWT that a migration settlement marked paid (2026-10-12). A customer pays an
// invoice net of EWT and the EWT is cleared later by its EWT credit memo (BIR 2307) -- on GROSS the
// EWT stays due until then (lib/invoiceDue.js). generate-invoice-payments.js wrote a CPAY-INV-<no>
// settlement for what the source counted as paid, and the source counts withheld EWT as paid:
//   INV-82506 (gross 6,238.40, EWT 111.40): CPAY-INV-82506 for exactly 111.40 beside the customer's
//   real 6,127.00 (CPAY-433) -- nothing due, and its EWT credit memo had nothing to apply to.
//   INV-73381 (EWT 57.62): CPAY-INV-73381 for 269.39 -- some cash plus the EWT.
//
// For each such settlement -- the script's CPAY-INV-<invoice no>, no user behind it, applied to that
// one invoice only -- on an invoice with EWT whose gross Amount Due is below its EWT: the EWT not yet
// showing as due is taken OUT of the settlement (never more than the settlement applied). What is
// left of it stays; a settlement left with nothing is removed. Settlements entered by users, and
// invoices whose EWT already shows as due (Rockwell's INV-80196), are not touched. The invoice's cash
// balance (amount_due) and status do not change: only its gross Amount Due goes back up by the EWT.
//
//   node src/db/reopen-ewt-settled-by-migration.js --dry-run
//   node src/db/reopen-ewt-settled-by-migration.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { grossDueSql } = require('../lib/invoiceDue');

const DRY_RUN = process.argv.includes('--dry-run');
const r2 = (n) => Math.round(Number(n) * 100) / 100;

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${DRY_RUN ? 'DRY RUN' : 'APPLYING'}`);
  const [rows] = await pool.query(
    `SELECT cp.id AS payment_id, cp.customer_payment_no, cp.payment_amount, cpl.id AS line_id, cpl.applied_amount,
            si.invoice_no, si.ewt_amount, ${grossDueSql('si')} AS due
       FROM customer_payments cp
       JOIN customer_payment_lines cpl ON cpl.customer_payment_id = cp.id
       JOIN sales_invoices si ON si.id = cpl.sales_invoice_id
      WHERE cp.customer_payment_no LIKE 'CPAY-INV-%' AND cp.customer_payment_no = CONCAT('CPAY-', si.invoice_no)
        AND cp.created_by_user_id IS NULL AND cp.status <> 'voided' AND si.status <> 'cancelled'
        AND COALESCE(si.ewt_amount, 0) > 0
        AND (SELECT COUNT(*) FROM customer_payment_lines x WHERE x.customer_payment_id = cp.id) = 1
      ORDER BY si.id`);
  const plan = rows.map((r) => {
    const hidden = r2(Number(r.ewt_amount) - Math.min(Number(r.due), Number(r.ewt_amount)));
    const take = r2(Math.min(hidden, Number(r.applied_amount)));
    return { ...r, take, left: r2(Number(r.applied_amount) - take) };
  }).filter((p) => p.take >= 0.005);
  const removed = plan.filter((p) => p.left < 0.005);
  const reduced = plan.filter((p) => p.left >= 0.005);
  const total = plan.reduce((s, p) => s + p.take, 0);
  console.log(`invoices with EWT hidden by a migration settlement: ${plan.length} | EWT reopened ${total.toFixed(2)}`);
  console.log(`  settlements removed (nothing but EWT): ${removed.length} | reduced by their EWT: ${reduced.length}`);
  plan.slice(0, 8).forEach((p) => console.log(`  ${p.customer_payment_no}: ${Number(p.applied_amount).toFixed(2)} -> ${p.left.toFixed(2)} (EWT ${p.take.toFixed(2)} back on ${p.invoice_no})`));
  if (!DRY_RUN && plan.length) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const p of plan) {
        if (p.left < 0.005) {
          await conn.query('DELETE FROM customer_payment_lines WHERE customer_payment_id = ?', [p.payment_id]);
          await conn.query('DELETE FROM customer_payments WHERE id = ?', [p.payment_id]);
        } else {
          await conn.query('UPDATE customer_payment_lines SET applied_amount = ? WHERE id = ?', [p.left, p.line_id]);
          await conn.query('UPDATE customer_payments SET payment_amount = ?, applied_amount = ? WHERE id = ?', [p.left, p.left, p.payment_id]);
        }
      }
      await conn.commit();
      console.log(`Done: ${removed.length} removed, ${reduced.length} reduced.`);
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
