// READ-ONLY. How a Sales Order's billing stands: each line's Job Order quantities, every Delivery
// Ticket against the order with whether its lines are tied to the order's lines (a line that is not
// cannot count toward the order's billing), and every invoice/DR. Written for SO-71114 (2026-10-05).
//
//   node src/db/inspect-so-billing.js SO-71114
require('dotenv').config();
const pool = require('../db');

(async () => {
  const no = process.argv[2];
  if (!no) throw new Error('Name the order: SO-71114');
  const [[so]] = await pool.query('SELECT id, sales_order_no, status FROM sales_orders WHERE sales_order_no = ?', [no]);
  if (!so) throw new Error(`${no} not found`);
  console.log(`${so.sales_order_no}  status=${so.status}`);
  const [lines] = await pool.query(
    `SELECT sol.id, sol.line_no, sol.quantity, jo.job_order_no, jo.quantity_delivered, jo.quantity_invoiced
       FROM sales_order_lines sol LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
      WHERE sol.sales_order_id = ? ORDER BY sol.line_no`, [so.id]);
  console.log('\nLines (SO line id | JO | ordered | delivered | invoiced)');
  for (const l of lines) console.log(`  ${l.line_no}. #${l.id} ${l.job_order_no || '-'} | ${+l.quantity} | ${+l.quantity_delivered} | ${+l.quantity_invoiced}`);
  const [dts] = await pool.query('SELECT id, dt_no, status, created_at FROM delivery_tickets WHERE sales_order_id = ? ORDER BY id', [so.id]);
  console.log(`\nDelivery Tickets: ${dts.length}`);
  for (const d of dts) {
    const [dl] = await pool.query('SELECT sales_order_line_id, job_order_id, quantity, description FROM delivery_ticket_lines WHERE delivery_ticket_id = ?', [d.id]);
    console.log(`  ${d.dt_no} ${d.status} (made ${String(d.created_at).slice(0, 24)})`);
    for (const l of dl) console.log(`     SO line ${l.sales_order_line_id ?? 'NOT LINKED'} | JO ${l.job_order_id ?? '-'} | qty ${+l.quantity} | ${String(l.description || '').slice(0, 50)}`);
  }
  const [sis] = await pool.query(
    'SELECT invoice_no, invoice_type, delivery_ticket_id, gross_amount, status, cancelled_at FROM sales_invoices WHERE sales_order_id = ? ORDER BY id', [so.id]);
  console.log(`\nInvoices / DRs: ${sis.length}`);
  for (const s of sis) console.log(`  ${s.invoice_no} ${s.invoice_type || 'SI'} ${s.status}${s.cancelled_at ? ' CANCELLED' : ''} gross ${s.gross_amount}${s.delivery_ticket_id ? ` (from DT id ${s.delivery_ticket_id})` : ''}`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
