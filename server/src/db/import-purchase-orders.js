// Migrates Purchase Orders (PO-####) and their line items from the live GraphicStar system.
// This is the foundation of the purchasing chain -- receiving reports, vendor returns, vendor
// bills and bill payments (imported by sibling scripts) all hang off the PO and its lines.
//
// Live shape (reverse-engineered from the SPA bundle + get_transactions schema):
//   get_purchase_orders {viewAll:true,limit,offset}     -> PO header list (needs viewAll or it
//        times out). UserPK_TransH = PO#, SysPK_TransH = the pk related records point at.
//   get_transaction_ledger_invtys {where:{SysFK_TransH_LdgrInvty: poPk}} -> the PO's line items.
//        POQty_LdgrInvty is the ordered qty (Qty_ is 0 on a PO); "...AmountIn" holds the money.
//        SysPK_LdgrInvty is the line pk that a receipt/return/bill line references back.
//
// We stash live_pk (PO) and live_line_pk (line) so the related-record importers can match by
// SysFK_TransHSL_TransH / SysFK_LdgrInvtyPO_LdgrInvty without re-deriving anything.
//
// Resumable (skips POs already imported by po_no) + idempotent per PO. Low concurrency to stay
// under the live rate limiter.
//   node src/db/import-purchase-orders.js --from=2026-01-01 --to=2026-07-31 --limit=20   (test)
//   node src/db/import-purchase-orders.js --from=2026-01-01 --to=2026-07-31
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
function argVal(name, def) { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; }
const FROM = argVal('from', '2026-01-01');
const TO = argVal('to', '2026-07-31');
const LIMIT = argVal('limit', null) ? Number(argVal('limit', null)) : null;
const FORCE = process.argv.includes('--force');
const CONCURRENCY = 3;
const DEFAULT_BASE_UNIT = 1;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clean = (v) => (v == null ? null : String(v).trim() || null);
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

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Purchase Orders | window ${FROM}..${TO}${LIMIT ? ` | LIMIT ${LIMIT}` : ''}${FORCE ? ' | FORCE' : ''}\n`);

  // Reference caches for resolution.
  const [sups] = await pool.query('SELECT id, name FROM suppliers');
  const supByName = new Map(sups.map((s) => [norm(s.name), s.id]));
  let supCreated = 0;
  // Serialize supplier creation: concurrent workers otherwise compute the same next SUP-### code.
  let supChain = Promise.resolve();
  async function resolveSupplier(name) {
    const key = norm(name);
    if (!key) return null;
    if (supByName.has(key)) return supByName.get(key);
    const run = supChain.then(async () => {
      if (supByName.has(key)) return supByName.get(key);
      const [[row]] = await pool.query('SELECT id FROM suppliers WHERE LOWER(name) = ? LIMIT 1', [key]);
      let id = row ? row.id : null;
      if (!id) {
        const [[mx]] = await pool.query("SELECT COALESCE(MAX(CAST(SUBSTRING(supplier_code,5) AS UNSIGNED)),0)+1 AS n FROM suppliers WHERE supplier_code LIKE 'SUP-%'");
        const code = `SUP-${String(mx.n).padStart(3, '0')}`;
        const [r] = await pool.query('INSERT INTO suppliers (supplier_code, name, is_active) VALUES (?,?,1)', [code, trunc(clean(name), 255)]);
        id = r.insertId; supCreated += 1;
      }
      supByName.set(key, id);
      return id;
    });
    supChain = run.catch(() => {});
    return run;
  }

  // PO lines usually reference their inventory item by SysFK_Invty (a live pk we don't store)
  // with the item CODE blank -- but the line's DisplayDescription matches inventories.display_name
  // exactly, so resolve by code first, then by name, and only fall back to the MISC-PO placeholder
  // for genuine non-inventory / service lines. Never create a code-less junk item.
  const [invs] = await pool.query('SELECT id, item_code, display_name FROM inventories');
  const invByCode = new Map();
  const invByName = new Map();
  for (const it of invs) {
    const ck = norm(it.item_code); if (ck && !invByCode.has(ck)) invByCode.set(ck, it.id);
    const nk = norm(it.display_name); if (nk && !invByName.has(nk)) invByName.set(nk, it.id);
  }
  let itemCreated = 0, miscItemId = invByCode.get(norm('MISC-PO')) || null;
  const itemInflight = new Map();
  async function resolveItem(code, desc) {
    const ck = norm(code), nk = norm(desc);
    if (ck && invByCode.has(ck)) return invByCode.get(ck);
    if (nk && invByName.has(nk)) return invByName.get(nk);
    if (!ck) { // no code -> shared placeholder (create once)
      if (miscItemId) return miscItemId;
      if (itemInflight.has('misc')) return itemInflight.get('misc');
      const run = (async () => {
        const [[row]] = await pool.query("SELECT id FROM inventories WHERE item_code='MISC-PO' LIMIT 1");
        let id = row ? row.id : null;
        if (!id) { const [r] = await pool.query('INSERT INTO inventories (item_code, display_name, base_unit_id, is_with_jo, is_po, is_jo) VALUES (?,?,?,0,1,0)', ['MISC-PO', 'Non-inventory / service PO line', DEFAULT_BASE_UNIT]); id = r.insertId; }
        miscItemId = id; return id;
      })();
      itemInflight.set('misc', run); return run;
    }
    if (itemInflight.has(ck)) return itemInflight.get(ck);
    const run = (async () => {
      const [[row]] = await pool.query('SELECT id FROM inventories WHERE LOWER(item_code) = ? LIMIT 1', [ck]);
      let id = row ? row.id : null;
      if (!id) { const [r] = await pool.query('INSERT INTO inventories (item_code, display_name, base_unit_id, is_with_jo, is_po, is_jo) VALUES (?,?,?,0,1,0)', [trunc(code, 100), trunc(clean(desc) || code, 255), DEFAULT_BASE_UNIT]); id = r.insertId; itemCreated += 1; }
      invByCode.set(ck, id);
      return id;
    })();
    itemInflight.set(ck, run);
    return run;
  }

  const token = await login();

  // Page the PO list (newest-first) and keep those in the window.
  const pos = [];
  for (let offset = 0; offset < 80000; offset += 200) {
    let list;
    try { list = listRows(await apiRetry(token, 'get_purchase_orders', { viewAll: true, limit: 200, offset })); }
    catch (e) { console.warn(`  page ${offset} failed: ${e.message}`); break; }
    if (!list.length) break;
    for (const po of list) {
      const d = day(po.DateCreated_TransH);
      if (d >= FROM && d <= TO) pos.push(po);
    }
    if (list.every((po) => day(po.DateCreated_TransH) < FROM)) break;
  }
  console.log(`Found ${pos.length} purchase order(s) in window.`);

  // Resume: skip POs already imported (unless --force).
  const [existing] = await pool.query('SELECT po_no FROM purchase_orders');
  const have = new Set(existing.map((r) => r.po_no));
  let targets = FORCE ? pos : pos.filter((po) => !have.has(po.UserPK_TransH));
  if (LIMIT) targets = targets.slice(0, LIMIT);
  console.log(`${targets.length} PO(s) to import${FORCE ? '' : ' (new only)'}.\n`);

  let done = 0, lineCount = 0, failed = 0, noLines = 0;
  await mapWithConcurrency(targets, CONCURRENCY, async (po) => {
    let lines;
    try { lines = listRows(await apiRetry(token, 'get_transaction_ledger_invtys', { where: { SysFK_TransH_LdgrInvty: po.SysPK_TransH } })); }
    catch (e) { failed += 1; return; }
    if (!lines.length) noLines += 1;

    const supplierId = await resolveSupplier(po.Name_Accnt);
    // Resolve each line's item up front (may create rows -- do it outside the tx).
    const prepared = [];
    for (const l of lines) {
      const itemId = await resolveItem(l.UserPK_Invty, l.DisplayDescription_LdgrInvty || l.Particulars_LdgrInvty);
      prepared.push([l, itemId]);
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (FORCE) {
        const [[ex]] = await conn.query('SELECT id FROM purchase_orders WHERE po_no = ?', [po.UserPK_TransH]);
        if (ex) { await conn.query('DELETE FROM purchase_order_lines WHERE purchase_order_id = ?', [ex.id]); await conn.query('DELETE FROM purchase_orders WHERE id = ?', [ex.id]); }
      }
      const [poRes] = await conn.query(
        `INSERT INTO purchase_orders
           (po_no, live_pk, type, date_created, supplier_id, ref_no, memo, subtotal, discount_amount,
            net_of_tax, tax_amount, total_amount, status, receipt_status, bill_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [po.UserPK_TransH, po.SysPK_TransH, trunc(po.Type_TransH, 60) || 'Standard', day(po.DateCreated_TransH) || FROM,
         supplierId, trunc(po.ReferrenceNO_TransH, 191), trunc(po.Memo_TransH, 500), num(po.SubTotal_TransH),
         num(po.DiscountAmount_TransH), num(po.SubTotal_TransH), num(po.TaxAmount_TransH), num(po.TotalAmount_TransH),
         trunc(po.Status_TransH, 60), 'not_received', 'unbilled']);
      const poId = poRes.insertId;
      let seq = 0;
      for (const [l, itemId] of prepared) {
        seq += 1;
        await conn.query(
          `INSERT INTO purchase_order_lines
             (purchase_order_id, live_line_pk, item_id, purchase_description, qty, purchase_unit, rate,
              disc_percent, disc_amount, net_of_tax, tax_amount, ext_price, received_qty, billed_qty)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [poId, l.SysPK_LdgrInvty, itemId, trunc(l.DisplayDescription_LdgrInvty || l.Particulars_LdgrInvty, 500),
           num(l.POQty_LdgrInvty) || num(l.Qty_LdgrInvty), trunc(l.UnitOfMeasure_LdgrInvty, 30),
           num(l.Rate_LdgrInvty) || num(l.Price_LdgrInvty), num(l.DiscountPercent_LdgrInvty), num(l.DiscountAmount_LdgrInvty),
           num(l.SubTotalAmountIn_LdgrInvty) || num(l.SubTotalAmountOut_LdgrInvty), num(l.TaxAmount_LdgrInvty),
           num(l.TotalAmountIn_LdgrInvty) || num(l.TotalAmountOut_LdgrInvty), num(l.ReceivedQty_LdgrInvty), num(l.BilledQty_LdgrInvty)]);
        lineCount += 1;
      }
      await conn.commit();
      done += 1;
      if (done % 200 === 0) console.log(`  ...${done}/${targets.length} POs (${lineCount} lines)`);
    } catch (e) { await conn.rollback(); failed += 1; if (failed <= 5) console.error(`  [error] ${po.UserPK_TransH}: ${e.message}`); }
    finally { conn.release(); }
  });

  console.log(`\nDone. ${done} PO(s) imported, ${lineCount} line(s). Failures: ${failed}. POs with no lines: ${noLines}.`);
  console.log(`Suppliers created: ${supCreated}, inventory items created: ${itemCreated}.`);
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
