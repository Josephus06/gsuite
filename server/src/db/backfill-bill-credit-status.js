// One-off, for what happened before lib/billCreditStatus.js kept statuses in step:
//   1. Bill Credits fully applied but still Open (BC-7431)            -> Fully Applied
//   2. the cheques those credits were made from (CHK-15926)            -> Fully Applied / Open,
//      by the same rule the app now applies (syncChequeForCredit)
//   3. vendor bills with nothing left due but still Open                -> Paid in Full
//      (the apply code already does this; this catches any left behind)
//
//   node src/db/backfill-bill-credit-status.js           # dry run
//   node src/db/backfill-bill-credit-status.js --apply
const pool = require('../db');
require('dotenv').config();
const { syncChequeForCredit } = require('../lib/billCreditStatus');

const APPLY = process.argv.includes('--apply');
const CREDIT_WHERE = "status = 'open' AND total_amount > 0 AND applied_amount >= total_amount - 0.005";
const BILL_WHERE = "status = 'open' AND gross_amount > 0 AND amount_due <= 0.005";
const sample = (rows, k) => (rows.length ? ` (e.g. ${rows.slice(0, 10).map((r) => r[k]).join(', ')})` : '');

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN'}`);
  const [credits] = await pool.query(`SELECT bill_credit_no FROM bill_credits WHERE ${CREDIT_WHERE} ORDER BY id`);
  console.log(`1. Credits Open but fully applied: ${credits.length}${sample(credits, 'bill_credit_no')}`);

  // Cheques a credit was made from, whose status the rule would change.
  const [cheques] = await pool.query(
    `SELECT c.cheque_no, c.status, c.total_amount, t.applied, t.credit_id
       FROM cheques c
       JOIN (SELECT cheque_id, MIN(id) AS credit_id,
                    SUM(CASE WHEN status = 'voided' THEN 0 ELSE applied_amount END) AS applied
               FROM bill_credits WHERE cheque_id IS NOT NULL GROUP BY cheque_id) t ON t.cheque_id = c.id
      WHERE c.status <> 'void'
        AND c.status <> IF(t.applied >= c.total_amount - 0.005 AND c.total_amount > 0, 'fully_applied', 'open')`);
  console.log(`2. Cheques to re-status from their credits: ${cheques.length}${sample(cheques.map((c) => ({ x: `${c.cheque_no} ${c.status}->${c.applied >= c.total_amount - 0.005 ? 'fully_applied' : 'open'}` })), 'x')}`);

  const [bills] = await pool.query(`SELECT bill_no FROM vendor_bills WHERE ${BILL_WHERE} ORDER BY id`);
  console.log(`3. Vendor bills Open with nothing due: ${bills.length}${sample(bills, 'bill_no')}`);
  if (!APPLY) return;

  const [r1] = await pool.query(`UPDATE bill_credits SET status = 'fully_applied' WHERE ${CREDIT_WHERE}`);
  for (const c of cheques) await syncChequeForCredit(pool, c.credit_id);
  const [r3] = await pool.query(`UPDATE vendor_bills SET status = 'paid_in_full' WHERE ${BILL_WHERE}`);
  console.log(`Done: ${r1.affectedRows} credit(s), ${cheques.length} cheque(s), ${r3.affectedRows} vendor bill(s).`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
