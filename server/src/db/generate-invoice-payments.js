// One-off: reconstructs a Customer Payment for each imported invoice that has been (part-)
// paid, so paid invoices show their payment in Related Records and the Customer Payments
// module has data.
//
// WHY reconstructed rather than pulled from live: the live API exposes get_customer_payments
// (a list of payment headers) but NO payment->invoice detail endpoint, so which invoices a
// live PAY-#### settled isn't retrievable. Each imported invoice already carries its paid
// amount (gross_amount - amount_due), so this creates one payment per paid invoice for that
// exact amount. Amounts are accurate; the grouping (one payment per invoice) and the
// payment numbers (CPAY-<invoice_no>) are synthetic, not the live PAY-#### records.
//
// Scoped to the 4 migrated reps' 2026 invoices. The invoice's amount_due is left untouched
// (already correct) -- this only records the settlement. Idempotent: re-running replaces
// the payment matched by its synthetic number.
//
//   node src/db/generate-invoice-payments.js --dry-run
//   node src/db/generate-invoice-payments.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
// Sales-1: Catherine(5), Arjie(7), Jocel(8), Michelle(9).
// Sales-3: Vanessa(69), Jerome(132), Paul(240), Margie(256), Nicole(269).
const REP_IDS = [5, 7, 8, 9, 69, 132, 240, 256, 269];
const DEPOSIT_ACCOUNT_CODE = '11000'; // Cash in Bank

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing written.\n' : 'APPLYING to local.\n');

  const [[deposit]] = await pool.query('SELECT id FROM chart_of_accounts WHERE account_code = ? LIMIT 1', [DEPOSIT_ACCOUNT_CODE]);
  const [[cashMethod]] = await pool.query("SELECT id FROM payment_methods WHERE name = 'CASH' LIMIT 1");

  const [invoices] = await pool.query(
    `SELECT si.id, si.invoice_no, si.date_created, si.gross_amount, si.amount_due,
            so.customer_id, si.office_location_id
     FROM sales_invoices si
     JOIN sales_orders so ON so.id = si.sales_order_id
     WHERE so.sales_rep_id IN (?) AND si.status <> 'cancelled'
       AND (si.gross_amount - si.amount_due) > 0.005`,
    [REP_IDS]
  );
  console.log(`${invoices.length} paid invoice(s) to record a payment for.`);

  if (DRY_RUN) {
    const total = invoices.reduce((s, i) => s + (Number(i.gross_amount) - Number(i.amount_due)), 0);
    console.log(`Would create ${invoices.length} customer payment(s) totalling ${total.toFixed(2)}.`);
    console.log('\nDRY RUN -- nothing written.');
    await pool.end();
    return;
  }

  let created = 0;
  for (const inv of invoices) {
    const paid = Number((Number(inv.gross_amount) - Number(inv.amount_due)).toFixed(2));
    const paymentNo = `CPAY-${inv.invoice_no}`;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Replace any prior synthetic payment for this invoice.
      const [[existing]] = await conn.query('SELECT id FROM customer_payments WHERE customer_payment_no = ?', [paymentNo]);
      if (existing) {
        await conn.query('DELETE FROM customer_payment_lines WHERE customer_payment_id = ?', [existing.id]);
        await conn.query('DELETE FROM customer_payments WHERE id = ?', [existing.id]);
      }
      const [pRes] = await conn.query(
        `INSERT INTO customer_payments
           (customer_payment_no, date_created, customer_id, office_location_id, deposit_account_id,
            payment_method_id, payment_amount, applied_amount, unapplied_amount, receipt_type, memo, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'Official Receipt', ?, 'not_deposited')`,
        [paymentNo, inv.date_created, inv.customer_id, inv.office_location_id, deposit ? deposit.id : null,
          cashMethod ? cashMethod.id : null, paid, paid, `Settlement for ${inv.invoice_no}`]
      );
      await conn.query(
        'INSERT INTO customer_payment_lines (customer_payment_id, sales_invoice_id, applied_amount) VALUES (?, ?, ?)',
        [pRes.insertId, inv.id, paid]
      );
      await conn.commit();
      created += 1;
    } catch (err) {
      await conn.rollback();
      console.warn(`!! ${paymentNo} failed: ${err.message}`);
    } finally {
      conn.release();
    }
  }

  console.log(`\nCreated ${created} customer payment(s).`);
  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
