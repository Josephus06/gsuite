// Migrates the records that hang off a Purchase Order: Receiving Reports (RR-####) and Vendor
// Returns (VR-####). Run AFTER import-purchase-orders.js -- these link to the local PO and its
// lines that script created.
//
// Live shape:
//   Receiving report headers: get_transactions {where:{Module_TransH:'PURCHASEREC',
//        SysFK_TransHSL_TransH: <PO pk>}}    (a receipt's source-link IS its PO's SysPK)
//   Vendor return headers:    get_transactions {where:{Module_TransH:'PURCHASERETURN', ...}}
//   Lines for either:         get_transaction_ledger_invtys {where:{SysFK_TransH_LdgrInvty:<pk>}}
//        Each line's SysFK_LdgrInvtyPO_LdgrInvty = the PO line's SysPK_LdgrInvty, which we stored
//        as purchase_order_lines.live_line_pk -- that's how a receipt/return line finds its PO line.
//
// Resumable (skips receipts/returns already imported by number) + idempotent. Low concurrency.
// VOID / CANCELLED receipts and returns are skipped, never migrated.
//
//   node src/db/import-purchasing-related.js --limit=50   (test on first 50 local POs)
//   node src/db/import-purchasing-related.js --from=2021-01-01 --to=2021-12-31   (that year's POs only)
//   node src/db/import-purchasing-related.js
const pool = require('../db');
require('dotenv').config();
const { isVoidOrCancelled } = require('./lib/liveWindow');

const SITE = 'http://gsuite.graphicstar.com.ph';
function argVal(name, def) { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; }
const LIMIT = argVal('limit', null) ? Number(argVal('limit', null)) : null;
// Walk only the POs dated in this window. Without it every local PO is re-queried against
// live on each run -- two API calls per PO, for years already migrated.
const FROM = argVal('from', null);
const TO = argVal('to', null);
const CONCURRENCY = 3;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const trunc = (v, n) => (v == null ? null : String(v).slice(0, n));
const day = (v) => (v || '').toString().slice(0, 10);
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  return (await r.json())?.data?.token;
}
async function api(token, ep, payload, ms = 60000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: ctl.signal });
    // Clear the abort timer only after the body is read: headers can arrive and then the
    // stream stall, and clearing on headers alone leaves that read with no timeout at all.
    const j = await r.json(); clearTimeout(t); return j;
  } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
}
async function apiRetry(token, ep, payload, attempts = 4) {
  let last; for (let a = 0; a < attempts; a += 1) {
    try { return await api(token, ep, payload, 60000 + a * 20000); }
    catch (e) { last = e; await sleep(1200 * (a + 1)); }
  }
  throw last;
}
async function mapWithConcurrency(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Receiving Reports + Vendor Returns${LIMIT ? ` | LIMIT ${LIMIT} POs` : ''}\n`);

  // Local POs with a live pk, and each PO's lines keyed by their live line pk.
  const [pos] = FROM && TO
    ? await pool.query('SELECT id, po_no, live_pk FROM purchase_orders WHERE live_pk IS NOT NULL AND date_created BETWEEN ? AND ?', [FROM, TO])
    : await pool.query('SELECT id, po_no, live_pk FROM purchase_orders WHERE live_pk IS NOT NULL');
  const [plines] = await pool.query('SELECT id, purchase_order_id, live_line_pk, item_id FROM purchase_order_lines WHERE live_line_pk IS NOT NULL');
  const lineByLivePk = new Map(plines.map((l) => [l.live_line_pk, l]));
  console.log(`Local: ${pos.length} PO(s), ${plines.length} PO line(s) with live pk.`);

  const [rrHave] = await pool.query('SELECT receipt_no FROM purchase_order_receipts');
  const haveRR = new Set(rrHave.map((r) => r.receipt_no));
  const [vrHave] = await pool.query('SELECT return_no FROM purchase_returns');
  const haveVR = new Set(vrHave.map((r) => r.return_no));

  const token = await login();
  let targets = pos;
  if (LIMIT) targets = targets.slice(0, LIMIT);

  let rrCount = 0, rrLines = 0, vrCount = 0, vrLines = 0, poDone = 0, unmatched = 0, failed = 0;

  // Insert one related doc (receipt or return) + its lines. `cfg` selects the table/columns.
  async function insertDoc(conn, kind, poId, head, lines) {
    const isRR = kind === 'RR';
    const table = isRR ? 'purchase_order_receipts' : 'purchase_returns';
    const noCol = isRR ? 'receipt_no' : 'return_no';
    const parentCol = isRR ? 'purchase_order_receipt_id' : 'purchase_return_id';
    const lineTable = isRR ? 'purchase_order_receipt_lines' : 'purchase_return_lines';
    const qtyCol = isRR ? 'qty_received' : 'qty_returned';

    // Header. Receipts carry is_on_hold NOT NULL; returns don't have it.
    let headId;
    if (isRR) {
      const [r] = await conn.query(
        `INSERT INTO ${table} (receipt_no, purchase_order_id, date_created, ref_no, memo, is_on_hold,
           subtotal, discount_amount, net_of_tax, tax_amount, total_amount)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [head.UserPK_TransH, poId, day(head.DateCreated_TransH), trunc(head.ReferrenceNO_TransH, 191), trunc(head.Memo_TransH, 500),
         head.IsOnHold_TransH ? 1 : 0, num(head.SubTotal_TransH), num(head.DiscountAmount_TransH),
         num(head.SubTotalVatEx_TransH) || num(head.SubTotal_TransH), num(head.TaxAmount_TransH), num(head.TotalAmount_TransH)]);
      headId = r.insertId;
    } else {
      const [r] = await conn.query(
        `INSERT INTO ${table} (return_no, purchase_order_id, date_created, ref_no, memo,
           subtotal, discount_amount, net_of_tax, tax_amount, total_amount)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [head.UserPK_TransH, poId, day(head.DateCreated_TransH), trunc(head.ReferrenceNO_TransH, 191), trunc(head.Memo_TransH, 500),
         num(head.SubTotal_TransH), num(head.DiscountAmount_TransH),
         num(head.SubTotalVatEx_TransH) || num(head.SubTotal_TransH), num(head.TaxAmount_TransH), num(head.TotalAmount_TransH)]);
      headId = r.insertId;
    }

    let n = 0;
    for (const l of lines) {
      const poLine = lineByLivePk.get(l.SysFK_LdgrInvtyPO_LdgrInvty) || lineByLivePk.get(l.SysFK_LdgrInvtySL_LdgrInvty);
      if (!poLine) { unmatched += 1; continue; } // can't satisfy NOT NULL purchase_order_line_id
      const qty = isRR
        ? (num(l.ReceivedQty_LdgrInvty) || num(l.QtyIn_LdgrInvty) || num(l.Qty_LdgrInvty))
        : (num(l.QtyOut_LdgrInvty) || num(l.Qty_LdgrInvty));
      await conn.query(
        `INSERT INTO ${lineTable} (${parentCol}, purchase_order_line_id, item_id, ${qtyCol}, rate,
           disc_percent, disc_amount, net_of_tax, tax_amount, ext_price)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [headId, poLine.id, poLine.item_id, qty, num(l.Rate_LdgrInvty) || num(l.Price_LdgrInvty),
         num(l.DiscountPercent_LdgrInvty), num(l.DiscountAmount_LdgrInvty),
         num(l.SubTotalAmountIn_LdgrInvty) || num(l.SubTotalAmountOut_LdgrInvty), num(l.TaxAmount_LdgrInvty),
         num(l.TotalAmountIn_LdgrInvty) || num(l.TotalAmountOut_LdgrInvty)]);
      n += 1;
    }
    return n;
  }

  await mapWithConcurrency(targets, CONCURRENCY, async (po) => {
    let rrs, vrs;
    try {
      rrs = listRows(await apiRetry(token, 'get_transactions', { where: { Module_TransH: 'PURCHASEREC', SysFK_TransHSL_TransH: po.live_pk } }))
        .filter((r) => !isVoidOrCancelled(r.Status_TransH));
      vrs = listRows(await apiRetry(token, 'get_transactions', { where: { Module_TransH: 'PURCHASERETURN', SysFK_TransHSL_TransH: po.live_pk } }))
        .filter((r) => !isVoidOrCancelled(r.Status_TransH));
    } catch (e) { failed += 1; return; }

    for (const [kind, docs, have] of [['RR', rrs, haveRR], ['VR', vrs, haveVR]]) {
      for (const head of docs) {
        // `have` is seeded from the DB and updated as we go, so a number is only ever imported once.
        if (have.has(head.UserPK_TransH)) continue;
        have.add(head.UserPK_TransH); // claim it now: concurrent workers must not race on the same number
        let lines = [];
        try { lines = listRows(await apiRetry(token, 'get_transaction_ledger_invtys', { where: { SysFK_TransH_LdgrInvty: head.SysPK_TransH } })); }
        catch (e) { /* import header with no lines rather than lose it */ }
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const n = await insertDoc(conn, kind, po.id, head, lines);
          await conn.commit();
          if (kind === 'RR') { rrCount += 1; rrLines += n; } else { vrCount += 1; vrLines += n; }
        } catch (e) { await conn.rollback(); failed += 1; if (failed <= 5) console.error(`  [error] ${head.UserPK_TransH}: ${e.message}`); }
        finally { conn.release(); }
      }
    }
    poDone += 1;
    if (poDone % 200 === 0) console.log(`  ...${poDone}/${targets.length} POs | RR ${rrCount} VR ${vrCount}`);
  });

  console.log(`\nDone. Receiving reports: ${rrCount} (${rrLines} lines). Vendor returns: ${vrCount} (${vrLines} lines).`);
  console.log(`Lines unmatched to a PO line (skipped): ${unmatched}. Failures: ${failed}.`);
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
