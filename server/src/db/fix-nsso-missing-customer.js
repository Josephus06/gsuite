// NSSOs saved with no customer, whose Job Orders therefore show no customer details (NSJO-SAM-2447,
// 2026-10-07). Each takes the customer of the document it nests to -- the Estimate of a Sample, the
// Sales Order of an RMA / RMA-Installation -- the same rule routes/nonStandardSalesOrders.js now
// applies on every save. One with nothing to take it from (an Internal NSSO, or a Sample with no
// estimate) is listed and left alone.
//
//   node src/db/fix-nsso-missing-customer.js            # preview
//   node src/db/fix-nsso-missing-customer.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [rows] = await pool.query(
    `SELECT n.id, n.nsso_no, n.type, e.estimate_no, so.sales_order_no,
            COALESCE(e.customer_id, so.customer_id) AS source_customer_id, c.name AS source_customer,
            (SELECT GROUP_CONCAT(jo.job_order_no) FROM job_orders jo WHERE jo.nsso_id = n.id) AS job_orders
       FROM non_standard_sales_orders n
       LEFT JOIN estimates e ON e.id = n.nested_estimate_id
       LEFT JOIN sales_orders so ON so.id = n.nested_sales_order_id
       LEFT JOIN customers c ON c.id = COALESCE(e.customer_id, so.customer_id)
      WHERE n.customer_id IS NULL
      ORDER BY n.id`);
  let fixed = 0;
  for (const r of rows) {
    const from = r.estimate_no || r.sales_order_no || '(nothing nested)';
    if (!r.source_customer_id) {
      console.log(`  ${r.nsso_no} (${r.type}): no customer, and ${from} has none to give -- left alone`);
      continue;
    }
    fixed += 1;
    console.log(`  ${r.nsso_no} (${r.type}) <- ${r.source_customer} from ${from}${r.job_orders ? `; JOs ${r.job_orders}` : ''}`);
    if (APPLY) await pool.query('UPDATE non_standard_sales_orders SET customer_id = ? WHERE id = ? AND customer_id IS NULL', [r.source_customer_id, r.id]);
  }
  console.log(`${rows.length} NSSO(s) without a customer, ${fixed} ${APPLY ? 'fixed' : 'can be fixed'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
