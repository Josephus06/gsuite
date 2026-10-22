// SO-68351 (asked 2026-10-22): its line still read the original 125,000 x 0.93 = 116,250 while the SO
// header, the source line (40,000 x 0.93 = 37,200, tax 4,464, gross 41,664), JO-68351-1-1's built and
// inspected 40,000 and DT-6354 (37,200) all say 40,000 -- so the Commission report's Weighted Sales for
// May read 79,050 too high (it adds up lines). Sets the line, and the JO's quantity, to 40,000.
// Audit-logged; refuses if the line has already been changed. Run once on the droplet:
//   node src/db/fix-so-68351-line.js
require('dotenv').config();
const pool = require('../db');

const NOTE = 'corrected to the source line (40,000 x 0.93) -- T1S kept the original 125,000 (2026-10-22)';

(async () => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[l]] = await conn.query(
      `SELECT sol.id, sol.sales_order_id, sol.quantity, sol.job_order_id FROM sales_order_lines sol
         JOIN sales_orders so ON so.id = sol.sales_order_id WHERE so.sales_order_no = 'SO-68351' FOR UPDATE`);
    if (!l) throw new Error('SO-68351 has no line.');
    if (Number(l.quantity) !== 125000) throw new Error(`the line reads ${l.quantity}, not 125,000 -- already corrected?`);
    await conn.query(
      'UPDATE sales_order_lines SET quantity = 40000, subtotal = 37200, disc_amount = 0, net_of_tax = 37200, tax_amount = 4464, gross_amount = 41664 WHERE id = ?',
      [l.id]);
    await conn.query('UPDATE job_orders SET quantity = 40000, updated_at = NOW() WHERE id = ? AND quantity = 125000', [l.job_order_id]);
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id) VALUES
        ('SalesOrder', ?, 'Updated', 'line 1 · quantity', '125000', ?, 1),
        ('SalesOrder', ?, 'Updated', 'line 1 · net_of_tax', '116250', ?, 1),
        ('JobOrder', ?, 'Updated', 'quantity', '125000', ?, 1)`,
      [l.sales_order_id, `40000 -- ${NOTE}`, l.sales_order_id, `37200 -- ${NOTE}`, l.job_order_id, `40000 -- ${NOTE}`]);
    await conn.commit();
    const [[a]] = await pool.query('SELECT quantity, net_of_tax, gross_amount FROM sales_order_lines WHERE id = ?', [l.id]);
    const [[j]] = await pool.query('SELECT job_order_no, quantity, quantity_built, quantity_inspected FROM job_orders WHERE id = ?', [l.job_order_id]);
    console.log('SO-68351 line now:', a, '\nJO now:', j);
  } catch (e) {
    await conn.rollback();
    console.error('Nothing changed:', e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
})();
