// Undo fix-double-counted-generated-settlements.js on the invoices that also carry a credit memo dated
// ON the cut-over day (the opening AR as-of date, 2026-09-30). The fix counted only credits dated AFTER the cut-over, so for these
// it could not tell whether the cut-over credit memo or the generated settlement was the real one
// (INV-11981 / CM-5519: the generated 18.78 was the real earlier payment). Restored exactly as they
// were -- the generated settlement's amount and status, the invoice's amount_due and status -- from the
// fix's own audit rows, and listed for Accounting to decide.
//
//   node src/db/restore-generated-settlement-cutover-cm.js --dry-run
//   node src/db/restore-generated-settlement-cutover-cm.js --by=<user id>
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { grossDueSql } = require('../lib/invoiceDue');

const DRY = process.argv.includes('--dry-run');
const byArg = process.argv.find((a) => a.startsWith('--by='));
const BY = byArg ? Number(byArg.split('=')[1]) : 1;
const MARK = '%fix-double-counted-generated-settlements%';
const num = (v) => Number(String(v ?? '').split(' ')[0]);

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY ? ' -- DRY RUN' : ''}\n`);
  const [[{ asof }]] = await pool.query('SELECT MAX(as_of) AS asof FROM opening_ar_items');
  const asOf = String(asof instanceof Date ? asof.toISOString() : asof).slice(0, 10);
  const [invs] = await pool.query(
    `SELECT DISTINCT si.id, si.invoice_no, si.amount_due, si.status FROM audit_logs a JOIN sales_invoices si ON si.id = a.auditable_id
      WHERE a.auditable_type = 'SalesInvoice' AND a.new_value LIKE ?
        AND EXISTS (SELECT 1 FROM credit_memo_applications cma JOIN credit_memos cm ON cm.id = cma.credit_memo_id
                     WHERE cma.sales_invoice_id = si.id AND cm.status <> 'voided' AND cm.date_created = ?)`, [MARK, asOf]);
  for (const inv of invs) {
    // The invoice's first amount_due before the fix, and its generated settlement's original line amount.
    const [[firstInv]] = await pool.query(
      "SELECT old_value FROM audit_logs WHERE auditable_type = 'SalesInvoice' AND auditable_id = ? AND new_value LIKE ? ORDER BY id LIMIT 1", [inv.id, MARK]);
    const [[syn]] = await pool.query(
      `SELECT cp.id AS payment_id, cp.customer_payment_no, cp.status, cpl.id AS line_id, cpl.applied_amount
         FROM customer_payment_lines cpl JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
        WHERE cpl.sales_invoice_id = ? AND cp.customer_payment_no LIKE 'CPAY-INV-%'`, [inv.id]);
    const [[firstPay]] = await pool.query(
      "SELECT field_name, old_value FROM audit_logs WHERE auditable_type = 'CustomerPayment' AND auditable_id = ? AND field_name = 'applied_amount' AND new_value LIKE ? ORDER BY id LIMIT 1",
      [syn.payment_id, MARK]);
    const origLine = firstPay ? num(firstPay.old_value) : Number(syn.applied_amount); // a straight void left the line as it was
    const origDue = num(firstInv.old_value);
    console.log(`${inv.invoice_no}: ${syn.customer_payment_no} ${syn.status} ${syn.applied_amount} -> not_deposited ${origLine}; amount_due ${inv.amount_due} -> ${origDue}`);
    if (DRY) continue;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('UPDATE customer_payment_lines SET applied_amount = ? WHERE id = ?', [origLine, syn.line_id]);
      await conn.query(
        "UPDATE customer_payments SET status = 'not_deposited', voided_at = NULL, voided_by_user_id = NULL, payment_amount = ?, applied_amount = ? WHERE id = ?",
        [origLine, origLine, syn.payment_id]);
      const [[g]] = await conn.query(`SELECT ${grossDueSql('si')} AS gdue FROM sales_invoices si WHERE si.id = ?`, [inv.id]);
      await conn.query("UPDATE sales_invoices SET amount_due = ?, status = IF(? <= 0.005, 'paid_in_full', status) WHERE id = ?", [origDue, Number(g.gdue), inv.id]);
      const note = 'restored -- a credit memo dated on the cut-over day; left for Accounting (restore-generated-settlement-cutover-cm.js)';
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id) VALUES
         ('CustomerPayment', ?, 'Updated', 'applied_amount', ?, ?, ?), ('SalesInvoice', ?, 'Updated', 'amount_due', ?, ?, ?)`,
        [syn.payment_id, `${syn.status} ${syn.applied_amount}`, `${origLine} -- ${note}`, BY, inv.id, String(inv.amount_due), `${origDue} -- ${note}`, BY]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  console.log(`\n${DRY ? 'Would restore' : 'Restored'} ${invs.length} invoice(s).`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
