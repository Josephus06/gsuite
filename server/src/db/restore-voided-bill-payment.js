// Restore a Bill Payment voided before voids posted a reversal journal, so it can be voided again
// properly (BPAY-13714, voided 2026-10-01 with no journal).
//
// Puts it back to Open and re-applies it: each bill it paid has its Amount Due recomputed from
// EVERY live application on it -- this payment's, other Bill Payments', Bill Credits' -- rather than
// simply decremented, because a bill can have been re-settled since the void (VB-24403 already
// reads 0 / Paid in Full). Refuses, and changes nothing, if the bill cannot absorb the payment
// again (it would be over-paid), if a credit it used has nothing left, or if a reversal journal
// already exists for it. One transaction.
//
//   node src/db/restore-voided-bill-payment.js BPAY-13714            # dry run
//   node src/db/restore-voided-bill-payment.js BPAY-13714 --apply
const pool = require('../db');
require('dotenv').config();
const { CREDIT_STATUS_SQL, syncChequeForCredit } = require('../lib/billCreditStatus');

const APPLY = process.argv.includes('--apply');
const NO = process.argv.find((a) => /^BPAY-/i.test(a));
const r2 = (n) => Number(Number(n).toFixed(2));

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN'}`);
  if (!NO) { console.log('Usage: node src/db/restore-voided-bill-payment.js BPAY-##### [--apply]'); return; }
  const [[bp]] = await pool.query('SELECT * FROM bill_payments WHERE bill_payment_no = ?', [NO]);
  if (!bp) { console.log(`${NO} not found.`); return; }
  if (bp.status !== 'voided') { console.log(`${NO} is ${bp.status}, not voided. Nothing to do.`); return; }
  const [[rev]] = await pool.query("SELECT journal_no FROM journals WHERE source_type = 'bill_payment' AND source_id = ? AND status <> 'void'", [bp.id]);
  if (rev) { console.log(`${NO} already has reversal ${rev.journal_no}; it was voided properly. Nothing done.`); return; }

  const [lines] = await pool.query('SELECT vendor_bill_id, bill_credit_id, applied_amount FROM bill_payment_lines WHERE bill_payment_id = ?', [bp.id]);
  const plan = []; const problems = [];
  for (const l of lines) {
    const amt = r2(l.applied_amount);
    if (l.vendor_bill_id) {
      const [[vb]] = await pool.query('SELECT id, bill_no, gross_amount, wtax_amount, amount_due, status FROM vendor_bills WHERE id = ?', [l.vendor_bill_id]);
      const owed = r2(Number(vb.gross_amount) - Number(vb.wtax_amount || 0));
      const [[others]] = await pool.query(
        `SELECT COALESCE((SELECT SUM(bpl.applied_amount) FROM bill_payment_lines bpl JOIN bill_payments p ON p.id = bpl.bill_payment_id
                           WHERE bpl.vendor_bill_id = ? AND p.status NOT IN ('void', 'voided') AND p.id <> ?), 0)
              + COALESCE((SELECT SUM(a.applied_amount) FROM bill_credit_applications a JOIN bill_credits c ON c.id = a.bill_credit_id
                           WHERE a.vendor_bill_id = ? AND c.status <> 'voided'), 0) AS applied`,
        [vb.id, bp.id, vb.id]);
      const newDue = r2(owed - Number(others.applied) - amt);
      console.log(`  ${vb.bill_no}: owed ${owed.toFixed(2)}, other live applications ${Number(others.applied).toFixed(2)}, this payment ${amt.toFixed(2)} -> amount due ${newDue.toFixed(2)} (now ${Number(vb.amount_due).toFixed(2)} / ${vb.status})`);
      if (newDue < -0.005) problems.push(`${vb.bill_no} would be over-paid by ${(-newDue).toFixed(2)} -- something else has settled it since the void`);
      else plan.push({ kind: 'bill', id: vb.id, newDue: Math.max(newDue, 0) });
    }
    if (l.bill_credit_id) {
      const [[bc]] = await pool.query('SELECT id, bill_credit_no, total_amount, applied_amount, status FROM bill_credits WHERE id = ?', [l.bill_credit_id]);
      const left = r2(Number(bc.total_amount) - Number(bc.applied_amount));
      console.log(`  ${bc.bill_credit_no}: ${left.toFixed(2)} left, this payment uses ${amt.toFixed(2)}`);
      if (bc.status === 'voided' || left < amt - 0.005) problems.push(`${bc.bill_credit_no} has only ${left.toFixed(2)} left (${bc.status})`);
      else plan.push({ kind: 'credit', id: bc.id, amt });
    }
  }
  if (problems.length) { console.log('\nNOT restorable:'); problems.forEach((p) => console.log(`  - ${p}`)); return; }
  console.log(`\n${NO} (${Number(bp.total_amount).toFixed(2)}, dated ${String(bp.date_created).slice(0, 10)}) can go back to Open.`);
  if (!APPLY) return;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const p of plan) {
      if (p.kind === 'bill') {
        await conn.query(
          "UPDATE vendor_bills SET amount_due = ?, status = IF(? <= 0.005, 'paid_in_full', 'open') WHERE id = ? AND status <> 'cancelled'",
          [p.newDue, p.newDue, p.id]);
      } else {
        await conn.query(`UPDATE bill_credits SET applied_amount = applied_amount + ?, ${CREDIT_STATUS_SQL} WHERE id = ?`, [p.amt, p.id]);
        await syncChequeForCredit(conn, p.id);
      }
    }
    const [u] = await conn.query("UPDATE bill_payments SET status = 'open', voided_at = NULL, voided_by_user_id = NULL WHERE id = ? AND status = 'voided'", [bp.id]);
    if (!u.affectedRows) throw new Error('Status changed since it was read; nothing restored.');
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('BillPayment', ?, 'Status Change', 'status', 'voided', 'open', NULL)`, [bp.id]);
    await conn.commit();
    console.log(`Restored ${NO} to Open. Void it again from its page -- that now posts the reversal journal.`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
