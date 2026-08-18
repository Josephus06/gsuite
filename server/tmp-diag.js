require('dotenv').config();
const pool=require('./src/db');
(async()=>{
  const [[c]]=await pool.query("SELECT id,name FROM customers WHERE name LIKE 'MATIAS H. AZNAR%'");
  console.log('--- MHAM payments live says are partly/fully unapplied ---');
  const [p]=await pool.query(`
    SELECT cp.customer_payment_no, cp.date_created, cp.payment_amount, cp.applied_amount, cp.unapplied_amount,
           (SELECT COUNT(*) FROM customer_payment_lines l WHERE l.customer_payment_id=cp.id) AS line_count
      FROM customer_payments cp
     WHERE cp.customer_id=? AND cp.status<>'voided' AND cp.unapplied_amount>0
     ORDER BY cp.payment_amount DESC LIMIT 8`,[c.id]);
  console.table(p);

  const [[o]]=await pool.query(`
    SELECT COUNT(*) n, ROUND(SUM(over_amt),2) total FROM (
      SELECT si.id,
        (COALESCE((SELECT SUM(l.applied_amount) FROM customer_payment_lines l
                    JOIN customer_payments cp ON cp.id=l.customer_payment_id
                   WHERE l.sales_invoice_id=si.id AND cp.status<>'voided'),0)
        +COALESCE((SELECT SUM(a.applied_amount) FROM credit_memo_applications a
                    JOIN credit_memos cm ON cm.id=a.credit_memo_id
                   WHERE a.sales_invoice_id=si.id AND cm.status<>'voided'),0)
        ) - si.gross_amount AS over_amt
        FROM sales_invoices si WHERE si.status<>'cancelled') t
     WHERE over_amt > 0.005`);
  console.log('--- Invoices settled BEYOND their gross amount ---');
  console.log('count:', o.n, '| total over-settlement:', o.total);
  await pool.end();
})();
