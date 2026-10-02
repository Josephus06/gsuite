// Invoices whose Amount Due still includes the withholding (EWT) -- INV-83093: Gross 1,625.48,
// EWT 29.03, Amount Due 1,625.48 where it should be 1,596.45.
//
// Settled 2026-09-30 (memory: invoice-discount-repair): Amount Due = Total Sales - Withholding on
// EVERY invoice, which is what the printout shows and what saving an invoice in T1S computes. The
// source was inconsistent (INV-81997 deducts, INV-82382 does not), and migrated invoices kept the
// source's figure, so the page and the printout disagree on those -- and Accept Payment, the open
// invoice lists and AR read the stored one.
//
// An invoice qualifies when it is still Open / Saved, carries EWT, and its Amount Due plus what is
// already applied to it (customer payments + credit memos) equals its Gross -- i.e. the EWT was
// never taken off. Its Amount Due drops by the EWT; one that reaches 0 becomes Paid in Full.
// Guarded on the Amount Due read; a rollback file holds the old values.
//
//   node src/db/repair-invoice-amount-due-ewt.js            # dry run
//   node src/db/repair-invoice-amount-due-ewt.js --apply
const fs = require('fs');
const pool = require('../db');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const r2 = (n) => Number(Number(n || 0).toFixed(2));

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN'}`);
  const [rows] = await pool.query(
    `SELECT si.id, si.invoice_no, si.status, si.gross_amount, si.ewt_amount, si.amount_due,
            COALESCE((SELECT SUM(l.applied_amount) FROM customer_payment_lines l JOIN customer_payments cp ON cp.id = l.customer_payment_id
                       WHERE l.sales_invoice_id = si.id AND cp.status NOT IN ('voided', 'void')), 0)
          + COALESCE((SELECT SUM(a.applied_amount) FROM credit_memo_applications a JOIN credit_memos cm ON cm.id = a.credit_memo_id
                       WHERE a.sales_invoice_id = si.id AND cm.status NOT IN ('voided', 'void')), 0) AS applied
       FROM sales_invoices si
      WHERE si.status IN ('open', 'saved') AND si.ewt_amount > 0`);
  const fix = rows.filter((r) => Math.abs(r2(r.gross_amount) - r2(r.applied) - r2(r.amount_due)) < 0.01)
    .map((r) => ({ ...r, new_due: Math.max(0, r2(Number(r.amount_due) - Number(r.ewt_amount))) }));
  const already = rows.length - fix.length;
  console.log(`Open/Saved invoices with EWT: ${rows.length}; EWT already off the Amount Due: ${already}; still including it: ${fix.length}`);
  console.log(`Amount Due reduced by ${r2(fix.reduce((s, r) => s + (Number(r.amount_due) - r.new_due), 0)).toLocaleString('en-US')} in all; becoming Paid in Full: ${fix.filter((r) => r.new_due <= 0.005).length}`);
  for (const r of fix.slice(0, 15)) {
    console.log(`  ${r.invoice_no}: gross ${r2(r.gross_amount)} - EWT ${r2(r.ewt_amount)} ; applied ${r2(r.applied)} ; Amount Due ${r2(r.amount_due)} -> ${r.new_due}`);
  }
  if (!APPLY || !fix.length) return;

  const file = `rollback/invoice-amount-due-ewt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.mkdirSync('rollback', { recursive: true });
  fs.writeFileSync(file, JSON.stringify(fix.map((r) => ({ id: r.id, invoice_no: r.invoice_no, amount_due: r.amount_due, status: r.status }))));
  let done = 0;
  for (const r of fix) {
    const [u] = await pool.query(
      "UPDATE sales_invoices SET amount_due = ?, status = IF(? <= 0.005, 'paid_in_full', status) WHERE id = ? AND ABS(amount_due - ?) < 0.005",
      [r.new_due, r.new_due, r.id, r.amount_due]);
    done += u.affectedRows;
  }
  console.log(`\nUpdated ${done} invoice(s). Rollback file: ${file}`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
