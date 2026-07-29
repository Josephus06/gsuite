// Migrates Vendor Bills (VB-####) -- the payables invoice a supplier issues against a PO's
// received goods. Run AFTER import-purchase-orders.js. PO-anchored (like the receiving-report /
// vendor-return importer): for each in-window PO we pull its bills, so scope follows the PO
// exactly -- a July PO billed in August is included, an in-window bill for an out-of-window PO
// is not. Bill payments (sibling script) settle these.
//
//   get_transactions {where:{Module_TransH:'VENDORBILL', SysFK_TransHSL_TransH:<PO pk>}} -> bills
//   get_transaction_ledger_invtys {where:{SysFK_TransH_LdgrInvty:<vbPk>}}                 -> lines
//        (a line's SysFK_LdgrInvtyPO_LdgrInvty = the PO line pk we stored as live_line_pk)
//
// Resumable (skips bills already imported by bill_no) + idempotent. Low concurrency.
//   node src/db/import-vendor-bills.js --limit=100   (first 100 local POs)
//   node src/db/import-vendor-bills.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
function argVal(name, def) { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; }
const LIMIT = argVal('limit', null) ? Number(argVal('limit', null)) : null;
const CONCURRENCY = 3;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const trunc = (v, n) => (v == null ? null : String(v).slice(0, n));
const day = (v) => (v || '').toString().slice(0, 10);
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase());
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
    clearTimeout(t); return await r.json();
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
function billStatus(live) {
  const s = (live || '').toUpperCase();
  if (s.includes('VOID') || s.includes('CANCEL')) return 'cancelled';
  if (s.includes('PAID')) return 'paid';
  if (s.includes('PARTIAL')) return 'partially_paid';
  return 'open';
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Vendor Bills (PO-anchored)${LIMIT ? ` | LIMIT ${LIMIT} POs` : ''}\n`);

  const [pos] = await pool.query('SELECT id, po_no, live_pk FROM purchase_orders WHERE live_pk IS NOT NULL');
  const [plines] = await pool.query('SELECT id, live_line_pk, item_id FROM purchase_order_lines WHERE live_line_pk IS NOT NULL');
  const lineByLivePk = new Map(plines.map((l) => [l.live_line_pk, l]));
  const [sups] = await pool.query('SELECT id, name FROM suppliers');
  const supByName = new Map(sups.map((s) => [norm(s.name), s.id]));
  console.log(`Local: ${pos.length} PO(s), ${lineByLivePk.size} PO line(s), ${supByName.size} supplier(s).`);

  const [have] = await pool.query('SELECT bill_no FROM vendor_bills');
  const haveVB = new Set(have.map((r) => r.bill_no));

  const token = await login();
  let targets = LIMIT ? pos.slice(0, LIMIT) : pos;

  let done = 0, lineCount = 0, unmatched = 0, failed = 0, poDone = 0;
  await mapWithConcurrency(targets, CONCURRENCY, async (po) => {
    let bills;
    try { bills = listRows(await apiRetry(token, 'get_transactions', { where: { Module_TransH: 'VENDORBILL', SysFK_TransHSL_TransH: po.live_pk } })); }
    catch (e) { failed += 1; return; }

    for (const vb of bills) {
      if (haveVB.has(vb.UserPK_TransH)) continue;
      let lines = [];
      try { lines = listRows(await apiRetry(token, 'get_transaction_ledger_invtys', { where: { SysFK_TransH_LdgrInvty: vb.SysPK_TransH } })); }
      catch (e) { /* header still worth keeping */ }

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.query(
          `INSERT INTO vendor_bills (bill_no, purchase_order_id, date_created, date_due, term, reference_no,
             memo, subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, wtax_amount, amount_due, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [vb.UserPK_TransH, po.id, day(vb.DateCreated_TransH), day(vb.DateDue_TransH) || null, trunc(vb.Term_TransH, 60),
           trunc(vb.ReferrenceNO_TransH, 191), trunc(vb.Memo_TransH, 500), num(vb.SubTotal_TransH), num(vb.DiscountAmount_TransH),
           num(vb.SubTotalVatEx_TransH) || num(vb.SubTotal_TransH), num(vb.TaxAmount_TransH), num(vb.TotalAmount_TransH),
           num(vb.WTAXAmount_TransH), num(vb.AmountDue_TransH), billStatus(vb.Status_TransH)]);
        const vbId = r.insertId;
        let n = 0;
        for (const l of lines) {
          const poLine = lineByLivePk.get(l.SysFK_LdgrInvtyPO_LdgrInvty) || lineByLivePk.get(l.SysFK_LdgrInvtySL_LdgrInvty);
          if (!poLine) { unmatched += 1; continue; }
          await conn.query(
            `INSERT INTO vendor_bill_lines (vendor_bill_id, purchase_order_line_id, item_id, qty, rate, unit_price,
               disc_percent, disc_amount, net_of_tax, tax_amount, ext_price, is_withhold, wtax_amount, amount_due)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [vbId, poLine.id, poLine.item_id, num(l.BilledQty_LdgrInvty) || num(l.Qty_LdgrInvty),
             num(l.Rate_LdgrInvty) || num(l.Price_LdgrInvty), num(l.Price_LdgrInvty) || num(l.Rate_LdgrInvty),
             num(l.DiscountPercent_LdgrInvty), num(l.DiscountAmount_LdgrInvty),
             num(l.SubTotalAmountIn_LdgrInvty) || num(l.SubTotalAmountOut_LdgrInvty), num(l.TaxAmount_LdgrInvty),
             num(l.TotalAmountIn_LdgrInvty) || num(l.TotalAmountOut_LdgrInvty),
             l.IsWithhold_LdgrInvty ? 1 : 0, num(l.WTAXAmount_LdgrInvty), num(l.AmountDue_LdgrInvty)]);
          n += 1;
        }
        await conn.commit();
        haveVB.add(vb.UserPK_TransH);
        done += 1; lineCount += n;
      } catch (e) { await conn.rollback(); failed += 1; if (failed <= 5) console.error(`  [error] ${vb.UserPK_TransH}: ${e.message}`); }
      finally { conn.release(); }
    }
    poDone += 1;
    if (poDone % 200 === 0) console.log(`  ...${poDone}/${targets.length} POs | ${done} bills (${lineCount} lines)`);
  });

  console.log(`\nDone. ${done} vendor bill(s), ${lineCount} line(s). Unmatched lines: ${unmatched}. Failures: ${failed}.`);
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
