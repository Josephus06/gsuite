// The sales import created estimate HEADERS but never the estimate line items
// (estimate_job_orders), so the imported estimates show "no items". In the live data model
// an estimate and its sales order share the SAME ledger lines -- which we already imported as
// sales_order_lines. So we can rebuild each estimate's line items LOCALLY from its SO lines,
// no live fetch needed, and it is faithful to the source.
//
// Idempotent: only acts on sales_order_lines whose estimate_job_order_id is still NULL, so
// re-running never duplicates, and manually-created app estimates are never touched.
//
//   node src/db/reconstruct-estimate-lines.js --dry-run
//   node src/db/reconstruct-estimate-lines.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING.\n');

  // Every SO line that (a) has no estimate line yet and (b) belongs to an SO that has an estimate.
  const [rows] = await pool.query(
    `SELECT sol.*, so.estimate_id
       FROM sales_order_lines sol
       JOIN sales_orders so ON so.id = sol.sales_order_id
      WHERE sol.estimate_job_order_id IS NULL
        AND so.estimate_id IS NOT NULL
      ORDER BY so.estimate_id, sol.line_no`
  );
  console.log(`${rows.length} SO line(s) need an estimate line.`);

  const estimatesTouched = new Set();
  let created = 0;
  for (const sol of rows) {
    estimatesTouched.add(sol.estimate_id);
    if (DRY_RUN) { created += 1; continue; }
    const [res] = await pool.query(
      `INSERT INTO estimate_job_orders
         (estimate_id, line_no, job_type_id, job_location_id, description, quantity, units,
          price_per_unit, subtotal, disc_percent, disc_amount, disc_price_per_unit,
          net_of_tax, tax_code_id, tax_amount, gross_amount, length, width, height, uom,
          shipping, remarks, memo, delivery_date, delivery_time, gp_rate, gp_amount)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [sol.estimate_id, sol.line_no, sol.job_type_id, sol.job_location_id, sol.description,
       sol.quantity, sol.units, sol.price_per_unit, sol.subtotal, sol.disc_percent, sol.disc_amount,
       sol.disc_price_per_unit, sol.net_of_tax, sol.tax_code_id, sol.tax_amount, sol.gross_amount,
       sol.length, sol.width, sol.height, sol.uom, sol.shipping, sol.remarks, sol.memo,
       sol.delivery_date, sol.delivery_time, sol.gp_rate, sol.gp_amount]
    );
    await pool.query('UPDATE sales_order_lines SET estimate_job_order_id = ? WHERE id = ?', [res.insertId, sol.id]);
    created += 1;
  }

  console.log(`\n${DRY_RUN ? 'Would create' : 'Created'} ${created} estimate line(s) across ${estimatesTouched.size} estimate(s).`);
  if (DRY_RUN) console.log('\nDRY RUN -- nothing written.');
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
