// Brings migrated POs' Received / Billed quantities up to the documents T1S holds (asked
// 2026-10-03, PO-20579: "Pending Billing" with RR-20146 in T1S, yet nothing billable).
//
// import-purchasing-related.js brought the source's Receiving Reports (RR-) and Vendor Returns
// (VR-) across as documents but never added their quantities to purchase_order_lines.received_qty,
// and the source's own PO line carries ReceivedQty 0 (PO-20579's line reads 0 there too) -- the
// source keeps the receipt only on the RR. The Bill button appears only on a line with more
// received than billed, so a migrated PO received in the source could never be billed here.
// 2026-10-03 on the droplet: 35,975 lines on 19,631 migrated POs had RR lines above their received_qty.
//
// For each migrated PO (live_pk set) still OPEN for billing (not cancelled, not fully billed --
// historical closed POs are left as they are), every line is set to:
//   received_qty = RR lines received - VR lines returned
//   billed_qty   = qty on the line's non-cancelled Vendor Bill lines
// each only ever RAISED, never lowered, so a receipt or bill entered in T1S since go-live stands.
// receipt_status / bill_status are then recomputed with the receive and bill routes' rules.
//
// Changes no stock, no GL: those come from the RR / bill documents themselves, unchanged.
// Dry run unless --apply; --apply writes a rollback file. Production: the droplet only.
//
//   node src/db/refresh-po-received-qty.js [--po=PO-20579] [--apply]
//   node src/db/refresh-po-received-qty.js --rollback=rollback/po-received-rollback-<stamp>.json
const fs = require('fs');
const path = require('path');
const pool = require('../db');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || null;
const ONLY = arg('po');
const ROLLBACK = arg('rollback');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const q4 = (n) => Math.round(n * 10000) / 10000;

function statuses(lines) {
  const allReceived = lines.length > 0 && lines.every((l) => num(l.received_qty) >= num(l.qty));
  const anyReceived = lines.some((l) => num(l.received_qty) > 0);
  const receipt = allReceived ? 'fully_received' : (anyReceived ? 'partially_received' : 'not_received');
  const rec = lines.filter((l) => num(l.received_qty) > 0);
  const fully = rec.filter((l) => num(l.billed_qty) >= num(l.received_qty)).length;
  const anyBilled = rec.some((l) => num(l.billed_qty) > 0);
  const bill = rec.length > 0 && fully === rec.length ? 'fully_billed' : (anyBilled ? 'partially_billed' : 'not_billed');
  return { receipt, bill };
}

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- DRY RUN, nothing written'}`);
  if (ROLLBACK) {
    const rb = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    for (const l of rb.lines) await pool.query('UPDATE purchase_order_lines SET received_qty = ?, billed_qty = ? WHERE id = ?', [l.received_qty, l.billed_qty, l.id]);
    for (const p of rb.pos) await pool.query('UPDATE purchase_orders SET receipt_status = ?, bill_status = ? WHERE id = ?', [p.receipt_status, p.bill_status, p.id]);
    console.log(`Rolled back ${rb.lines.length} line(s) on ${rb.pos.length} PO(s).`);
    return;
  }
  const [pos] = await pool.query(
    `SELECT id, po_no, status, receipt_status, bill_status FROM purchase_orders
      WHERE live_pk IS NOT NULL AND LOWER(status) NOT IN ('cancelled', 'fully billed', 'closed', 'void')
        AND (bill_status IS NULL OR bill_status <> 'fully_billed') ${ONLY ? 'AND po_no = ?' : ''}`, ONLY ? [ONLY] : []);
  console.log(`Open migrated POs: ${pos.length}`);
  if (!pos.length) return;
  const ids = pos.map((p) => p.id);
  const [lines] = await pool.query(
    `SELECT pol.id, pol.purchase_order_id, pol.qty, pol.received_qty, pol.billed_qty,
            COALESCE((SELECT SUM(rl.qty_received) FROM purchase_order_receipt_lines rl WHERE rl.purchase_order_line_id = pol.id), 0)
          - COALESCE((SELECT SUM(vl.qty_returned) FROM purchase_return_lines vl WHERE vl.purchase_order_line_id = pol.id), 0) AS doc_received,
            COALESCE((SELECT SUM(bl.qty) FROM vendor_bill_lines bl JOIN vendor_bills vb ON vb.id = bl.vendor_bill_id
                       WHERE bl.purchase_order_line_id = pol.id AND vb.status <> 'cancelled'), 0) AS doc_billed
       FROM purchase_order_lines pol WHERE pol.purchase_order_id IN (?)`, [ids]);
  const byPo = new Map(); for (const l of lines) { if (!byPo.has(l.purchase_order_id)) byPo.set(l.purchase_order_id, []); byPo.get(l.purchase_order_id).push(l); }

  const plan = [];
  for (const po of pos) {
    const ls = byPo.get(po.id) || [];
    const changes = [];
    const after = ls.map((l) => {
      const rcv = q4(Math.max(num(l.received_qty), num(l.doc_received)));
      const bil = q4(Math.max(num(l.billed_qty), num(l.doc_billed)));
      if (rcv !== q4(num(l.received_qty)) || bil !== q4(num(l.billed_qty))) changes.push({ line: l, received_qty: rcv, billed_qty: bil });
      return { qty: l.qty, received_qty: rcv, billed_qty: bil };
    });
    const st = statuses(after);
    // Only POs whose quantities move: a status-only difference is the importer's 'unbilled'
    // spelling of 'not_billed', the same thing, and not worth touching 160 rows for.
    if (changes.length) plan.push({ po, changes, st });
  }
  const billable = plan.filter((p) => p.changes.some((c) => c.received_qty > c.billed_qty)).length;
  console.log(`POs to update: ${plan.length} (${plan.reduce((s, p) => s + p.changes.length, 0)} lines); billable afterwards: ${billable}`);
  for (const p of plan.slice(0, 15)) {
    console.log(`  ${p.po.po_no} (${p.po.status}): ${p.changes.map((c) => `rcv ${num(c.line.received_qty)}->${c.received_qty}, billed ${num(c.line.billed_qty)}->${c.billed_qty}`).join('; ') || 'statuses only'} => ${p.st.receipt} / ${p.st.bill}`);
  }
  if (!APPLY || !plan.length) return;

  const rollback = { lines: [], pos: [] };
  const outDir = path.join(__dirname, '..', '..', 'rollback'); fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `po-received-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const conn = await pool.getConnection();
  try {
    for (let i = 0; i < plan.length; i += 200) {
      await conn.beginTransaction();
      for (const p of plan.slice(i, i + 200)) {
        rollback.pos.push({ id: p.po.id, receipt_status: p.po.receipt_status, bill_status: p.po.bill_status });
        for (const c of p.changes) {
          rollback.lines.push({ id: c.line.id, received_qty: c.line.received_qty, billed_qty: c.line.billed_qty });
          await conn.query('UPDATE purchase_order_lines SET received_qty = ?, billed_qty = ? WHERE id = ?', [c.received_qty, c.billed_qty, c.line.id]);
        }
        await conn.query('UPDATE purchase_orders SET receipt_status = ?, bill_status = ? WHERE id = ?', [p.st.receipt, p.st.bill, p.po.id]);
      }
      await conn.commit();
      fs.writeFileSync(file, JSON.stringify(rollback));
    }
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  console.log(`Updated ${rollback.lines.length} line(s) on ${rollback.pos.length} PO(s). Rollback: ${file}`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
