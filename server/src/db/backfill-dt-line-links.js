// Link migrated Delivery Ticket lines to the Sales Order line (and its JO) they bill (2026-10-09).
//
// 16,244 of 16,272 DT lines came over with neither sales_order_line_id nor job_order_id. Everything
// that reads an open ticket as billed goes through that link (lib/salesOrderStatus.js openDtQtySql):
// SO-71070's DT-6339 bills nine completed JOs, yet the SO's Invoiced column read 0 for all of them,
// and the Create DT / Create SI forms would offer those quantities again.
//
// Each unlinked line is matched to a line of its ticket's own Sales Order:
//   1. same description (case and spacing ignored) and same quantity;
//   2. else same description, if only one such SO line is still unclaimed;
// each SO line taken once per ticket. Anything else is listed and left alone -- never guessed.
//
//   node src/db/backfill-dt-line-links.js --dry-run
//   node src/db/backfill-dt-line-links.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
const same = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.0001;

async function main() {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${DRY_RUN ? 'DRY RUN' : 'APPLYING'}`);
  const [lines] = await pool.query(
    `SELECT l.id, l.delivery_ticket_id, l.description, l.item_name, l.quantity, d.sales_order_id, d.dt_no, d.status
       FROM delivery_ticket_lines l JOIN delivery_tickets d ON d.id = l.delivery_ticket_id
      WHERE l.sales_order_line_id IS NULL AND d.sales_order_id IS NOT NULL
      ORDER BY l.delivery_ticket_id, l.line_no, l.id`);
  const soIds = [...new Set(lines.map((l) => l.sales_order_id))];
  const solBySo = new Map();
  for (let i = 0; i < soIds.length; i += 2000) {
    const [sols] = await pool.query(
      'SELECT id, sales_order_id, line_no, description, quantity, job_order_id FROM sales_order_lines WHERE sales_order_id IN (?)',
      [soIds.slice(i, i + 2000)]);
    for (const s of sols) {
      if (!solBySo.has(s.sales_order_id)) solBySo.set(s.sales_order_id, []);
      solBySo.get(s.sales_order_id).push(s);
    }
  }

  const updates = []; const unmatched = [];
  const byTicket = new Map();
  for (const l of lines) { if (!byTicket.has(l.delivery_ticket_id)) byTicket.set(l.delivery_ticket_id, []); byTicket.get(l.delivery_ticket_id).push(l); }
  for (const tl of byTicket.values()) {
    const taken = new Set();
    const sols = solBySo.get(tl[0].sales_order_id) || [];
    for (const l of tl) {
      const desc = norm(l.description || l.item_name);
      const free = sols.filter((s) => !taken.has(s.id) && norm(s.description) === desc);
      const pick = free.find((s) => same(s.quantity, l.quantity)) || (free.length === 1 ? free[0] : null);
      if (!pick) { unmatched.push(l); continue; }
      taken.add(pick.id);
      updates.push([pick.id, pick.job_order_id || null, l.id, l]);
    }
  }
  const open = (arr, f) => arr.filter((x) => f(x) === 'open').length;
  console.log(`unlinked DT lines ${lines.length} | matched ${updates.length} (open tickets: ${open(updates, (u) => u[3].status)}) | unmatched ${unmatched.length} (open tickets: ${open(unmatched, (u) => u.status)})`);
  const sample = updates.filter((u) => u[3].dt_no === 'DT-6339');
  if (sample.length) console.log(`  DT-6339: ${sample.length} line(s) -> SO lines ${sample.map((u) => u[0]).join(', ')}`);
  unmatched.filter((u) => u.status === 'open').slice(0, 15).forEach((u) => console.log(`  open, unmatched: ${u.dt_no} "${String(u.description || u.item_name || '').slice(0, 50)}" x${u.quantity}`));

  if (!DRY_RUN && updates.length) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const [solId, joId, id] of updates) {
        await conn.query(
          'UPDATE delivery_ticket_lines SET sales_order_line_id = ?, job_order_id = COALESCE(job_order_id, ?) WHERE id = ? AND sales_order_line_id IS NULL',
          [solId, joId, id]);
      }
      await conn.commit();
      console.log(`Linked ${updates.length} DT line(s).`);
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  await pool.end();
}
main().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
