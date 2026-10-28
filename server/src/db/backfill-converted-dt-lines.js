// Converted Delivery Tickets that became no invoice -- their lines, so they bill their JOs in T1S.
//
// Found 2026-10-28 from JO-55784-2-8, "invoiced in the source but not in T1S". SO-55784 is a 100%
// sponsorship: every line fully discounted, billed on DT-4248 / DT-4191 at 0.00 and CONVERTED there
// with no invoice ever raised. The source counts those JOs Invoiced. In T1S the ticket came in as
// 'converted' with NO lines (import-delivery-tickets.js only takes lines of open tickets -- a
// converted one's billing is normally on its invoice), and there is no invoice, so nothing billed
// the JOs: Pending Billing listed them and their Qty Invoiced stayed 0. 161 converted tickets have
// no invoice in T1S (107 of them 0.00).
//
// For each converted, lineless T1S ticket with no invoice: the ticket's lines from the source
// (get_invoice on the ticket still returns them, each naming its JO), written with the JO's T1S id,
// then each JO's Qty Invoiced raised to what billed it -- never lowered, never past its quantity.
// Pending Billing counts such a ticket's lines as billing (routes/pendingBillingReport.js).
//
// READ-ONLY against the source. Dry run unless --apply.
//   node src/db/backfill-converted-dt-lines.js [--only=DT-4248] [--apply]
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const L = require('./lib/liveWindow');

const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const trunc = (s, n) => { const c = String(s ?? '').trim().replace(/\s+/g, ' '); return c ? c.slice(0, n) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(t, ep, payload) {
  for (let a = 0; a < 4; a += 1) {
    try { return await L.api(t, ep, payload); } catch (e) { if (a === 3) throw e; await sleep(2000 * (a + 1)); }
  }
  return null;
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN'}`);
  const [dts] = await pool.query(
    `SELECT dt.id, dt.dt_no, dt.sales_order_id, dt.gross_amount FROM delivery_tickets dt
      WHERE dt.status = 'converted'
        AND NOT EXISTS (SELECT 1 FROM delivery_ticket_lines l WHERE l.delivery_ticket_id = dt.id)
        AND NOT EXISTS (SELECT 1 FROM sales_invoices si WHERE si.delivery_ticket_id = dt.id AND si.status <> 'cancelled')
        ${ONLY ? 'AND dt.dt_no = ?' : ''}
      ORDER BY dt.id`, ONLY ? [ONLY] : []);
  console.log(`Converted tickets with no lines and no invoice: ${dts.length}\n`);

  const t = await L.login();
  const stats = { tickets: 0, notInSource: 0, noLines: 0, lines: 0, joNotInT1s: 0, josRaised: 0 };
  const billed = new Map(); // T1S JO id -> qty billed by these tickets
  const [[headOffice]] = await pool.query("SELECT id FROM locations WHERE location_name LIKE 'Head Office%' LIMIT 1");

  for (const dt of dts) {
    const head = L.listRows(await api(t, 'get_transactions', { where: { UserPK_TransH: dt.dt_no, Module_TransH: 'DELIVERYTICKET' }, limit: 1 }))[0];
    if (!head) { stats.notInSource += 1; console.log(`  ${dt.dt_no}: not in the source`); continue; }
    if (L.isVoidOrCancelled(head.Status_TransH)) { console.log(`  ${dt.dt_no}: ${head.Status_TransH} in the source -- left alone`); continue; }
    const det = await api(t, 'get_invoice', { pk: head.SysPK_TransH });
    const lines = Array.isArray(det?.data?.[1]) ? det.data[1] : [];
    if (!lines.length) { stats.noLines += 1; console.log(`  ${dt.dt_no}: the source returns no lines`); continue; }

    const rows = [];
    for (const l of lines) {
      const joNo = trunc(l.UserPK_TransH, 60);
      const [[jo]] = joNo ? await pool.query('SELECT id, quantity FROM job_orders WHERE job_order_no = ?', [joNo]) : [[null]];
      if (joNo && !jo) stats.joNotInT1s += 1;
      rows.push({ l, joNo, jo });
    }
    stats.tickets += 1;
    console.log(`  ${dt.dt_no} (${num(dt.gross_amount).toFixed(2)}): ${rows.map((r) => `${r.joNo || '(no JO)'}${r.jo ? '' : ' [not in T1S]'} x${num(r.l.Qty_LdgrInvty)}`).join(', ')}`);
    for (const r of rows) if (r.jo) billed.set(r.jo.id, (billed.get(r.jo.id) || 0) + num(r.l.Qty_LdgrInvty));
    if (!APPLY) { stats.lines += rows.length; continue; }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      let ln = 0;
      for (const { l, jo } of rows) {
        ln += 1;
        await conn.query(
          `INSERT INTO delivery_ticket_lines
             (delivery_ticket_id, line_no, job_order_id, item_name, description, location_id, quantity, units, price_per_unit,
              subtotal, disc_percent, disc_amount, disc_price_per_unit, net_of_tax, tax_code, tax_amount, gross_amount)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [dt.id, ln, jo ? jo.id : null, trunc(l.DisplayName_Job || l.UserPK_Invty, 255), trunc(l.DisplayDescription_LdgrInvty, 500),
            headOffice ? headOffice.id : null, num(l.Qty_LdgrInvty), trunc(l.UnitOfMeasure_LdgrInvty, 30), num(l.Price_LdgrInvty),
            num(l.SubTotalAmountOut_LdgrInvty), num(l.DiscountPercent_LdgrInvty), num(l.DiscountAmount_LdgrInvty),
            Math.round((num(l.Price_LdgrInvty) - num(l.DiscountRate_LdgrInvty)) * 1e6) / 1e6,
            num(l.Total_LdgrInvty != null && l.Total_LdgrInvty !== '' ? l.Total_LdgrInvty : l.SubTotalAmountOut_LdgrInvty),
            trunc(l.TaxCode_LdgrInvty, 40), num(l.TaxAmount_LdgrInvty), num(l.TotalAmountOut_LdgrInvty)]);
        stats.lines += 1;
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); console.log(`    !! ${dt.dt_no}: ${e.message}`); } finally { conn.release(); }
  }

  // Qty Invoiced: raised to what billed it (invoice lines + these tickets), capped at the JO's own.
  for (const [joId, qty] of billed) {
    const [[jo]] = await pool.query(
      `SELECT jo.job_order_no, jo.quantity, jo.quantity_invoiced,
              COALESCE((SELECT SUM(l.quantity) FROM sales_invoice_lines l JOIN sales_invoices si ON si.id = l.sales_invoice_id
                         WHERE l.job_order_id = jo.id AND si.status <> 'cancelled'), 0) AS inv_qty
         FROM job_orders jo WHERE jo.id = ?`, [joId]);
    const want = Math.min(num(jo.quantity), num(jo.inv_qty) + qty);
    if (want > num(jo.quantity_invoiced) + 0.0001) {
      stats.josRaised += 1;
      console.log(`  ${jo.job_order_no}: Qty Invoiced ${num(jo.quantity_invoiced)} -> ${want}`);
      if (APPLY) await pool.query('UPDATE job_orders SET quantity_invoiced = GREATEST(quantity_invoiced, ?), updated_at = NOW() WHERE id = ?', [want, joId]);
    }
  }

  console.log(`\n${JSON.stringify(stats)}`);
  if (!APPLY) console.log('DRY RUN -- nothing written. Re-run with --apply.');
  await pool.end();
})().catch(async (e) => { console.error('ERR', e.message); await pool.end(); process.exit(1); });
