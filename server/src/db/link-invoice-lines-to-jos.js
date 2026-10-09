// Tie Sales Order invoices' lines to the JO they bill, and bring the JO and its order up to date
// (2026-10-09). Run after import-invoices-by-number.js (and generate-invoice-payments.js): that import
// writes the invoice and its lines but names no JO, so SO-3214 still read Partially Billed with
// JO-3214-2-2 at Invoiced 0 once INV-5668 was in.
//
//   1. A line with no JO, on an invoice raised from a Sales Order, is matched to that order's line with
//      the same description (case and spacing ignored) and quantity -- else the same description, when
//      only one such line is still unclaimed on that invoice. Unmatched lines are listed, left alone.
//   2. Each JO touched: quantity_invoiced is raised to what its linked, live invoice lines add up to
//      (never lowered -- a migrated counter can hold more than the lines show); once that covers its
//      quantity, a JO at Completed becomes Invoiced.
//   3. Each order touched: its status is the app's own rule again (lib/salesOrderStatus.js) -- moving
//      forward only; an order already Billed is left Billed.
//
//   node src/db/link-invoice-lines-to-jos.js --dry-run
//   node src/db/link-invoice-lines-to-jos.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { computeSalesOrderStatus, invoicedOrTicketedSql, statusRuleReady } = require('../lib/salesOrderStatus');

const DRY_RUN = process.argv.includes('--dry-run');
const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
const same = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.0001;

async function main() {
  await statusRuleReady;
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${DRY_RUN ? 'DRY RUN' : 'APPLYING'}`);
  const [lines] = await pool.query(
    `SELECT l.id, l.sales_invoice_id, l.description, l.quantity, si.invoice_no, si.sales_order_id
       FROM sales_invoice_lines l JOIN sales_invoices si ON si.id = l.sales_invoice_id
      WHERE l.job_order_id IS NULL AND si.sales_order_id IS NOT NULL AND si.status <> 'cancelled'
      ORDER BY l.sales_invoice_id, l.id`);
  const soIds = [...new Set(lines.map((l) => l.sales_order_id))];
  const solBySo = new Map();
  for (let i = 0; i < soIds.length; i += 2000) {
    const [sols] = await pool.query(
      `SELECT id, sales_order_id, description, quantity, job_order_id FROM sales_order_lines
        WHERE sales_order_id IN (?) AND job_order_id IS NOT NULL`, [soIds.slice(i, i + 2000)]);
    for (const s of sols) { if (!solBySo.has(s.sales_order_id)) solBySo.set(s.sales_order_id, []); solBySo.get(s.sales_order_id).push(s); }
  }

  const links = []; const unmatched = [];
  const byInvoice = new Map();
  for (const l of lines) { if (!byInvoice.has(l.sales_invoice_id)) byInvoice.set(l.sales_invoice_id, []); byInvoice.get(l.sales_invoice_id).push(l); }
  for (const il of byInvoice.values()) {
    const taken = new Set();
    const sols = solBySo.get(il[0].sales_order_id) || [];
    for (const l of il) {
      const free = sols.filter((s) => !taken.has(s.id) && norm(s.description) === norm(l.description));
      const pick = free.find((s) => same(s.quantity, l.quantity)) || (free.length === 1 ? free[0] : null);
      if (!pick) { unmatched.push(l); continue; }
      taken.add(pick.id);
      links.push({ lineId: l.id, solId: pick.id, joId: pick.job_order_id, soId: l.sales_order_id, inv: l.invoice_no });
    }
  }
  console.log(`unlinked lines on SO invoices ${lines.length} | matched ${links.length} | unmatched ${unmatched.length}`);
  unmatched.slice(0, 10).forEach((u) => console.log(`  unmatched: ${u.invoice_no} "${String(u.description || '').slice(0, 50)}" x${u.quantity}`));
  const s3214 = links.filter((x) => x.inv === 'INV-5668');
  if (s3214.length) console.log(`  INV-5668 -> JO id(s) ${s3214.map((x) => x.joId).join(', ')}`);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const k of links) {
      await conn.query('UPDATE sales_invoice_lines SET job_order_id = ?, sales_order_line_id = COALESCE(sales_order_line_id, ?) WHERE id = ? AND job_order_id IS NULL',
        [k.joId, k.solId, k.lineId]);
    }
    // 2. JOs: what their linked live lines add up to (the links above are visible inside this transaction).
    const joIds = [...new Set(links.map((k) => k.joId))];
    let joRaised = 0; let joStaged = 0;
    for (let i = 0; i < joIds.length; i += 2000) {
      const [jos] = await conn.query(
        `SELECT jo.id, jo.quantity, jo.quantity_invoiced, jo.production_stage,
                (SELECT COALESCE(SUM(l.quantity), 0) FROM sales_invoice_lines l JOIN sales_invoices si ON si.id = l.sales_invoice_id
                  WHERE l.job_order_id = jo.id AND si.status <> 'cancelled') AS billed
           FROM job_orders jo WHERE jo.id IN (?)`, [joIds.slice(i, i + 2000)]);
      for (const j of jos) {
        const qi = Math.max(Number(j.quantity_invoiced || 0), Number(j.billed || 0));
        const stage = qi >= Number(j.quantity || 0) - 0.0001 && j.production_stage === 'completed' ? 'invoiced' : j.production_stage;
        if (qi === Number(j.quantity_invoiced || 0) && stage === j.production_stage) continue;
        if (qi !== Number(j.quantity_invoiced || 0)) joRaised += 1;
        if (stage !== j.production_stage) joStaged += 1;
        await conn.query('UPDATE job_orders SET quantity_invoiced = ?, production_stage = ?, updated_at = NOW() WHERE id = ?', [qi, stage, j.id]);
      }
    }
    // 3. Orders.
    const touched = [...new Set(links.map((k) => k.soId))];
    const moves = {};
    for (const soId of touched) {
      const [[so]] = await conn.query('SELECT id, sales_order_no, status FROM sales_orders WHERE id = ?', [soId]);
      if (!so || so.status === 'cancelled') continue;
      const [sl] = await conn.query(
        `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, ${invoicedOrTicketedSql('jo')}
           FROM sales_order_lines sol LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`, [soId]);
      const next = computeSalesOrderStatus(sl);
      // Linking only adds billing, so it only moves an order forward. One already Billed stays so --
      // for a migrated order the source decides that (db/fix-so-partially-billed.js).
      if (next === so.status || so.status === 'billed') continue;
      const k = `${so.status} -> ${next}`; moves[k] = (moves[k] || 0) + 1;
      if (so.sales_order_no === 'SO-3214') console.log(`  SO-3214: ${k}`);
      await conn.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [next, soId]);
    }
    console.log(`JOs: invoiced qty raised ${joRaised}, moved to Invoiced ${joStaged} | orders re-statused: ${JSON.stringify(moves)}`);
    if (DRY_RUN) { await conn.rollback(); console.log('DRY RUN -- rolled back, nothing written.'); }
    else { await conn.commit(); console.log('Applied.'); }
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  await pool.end();
}
main().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
