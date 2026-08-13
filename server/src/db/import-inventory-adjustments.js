// Migrates Inventory Adjustments (IA-####) created Jan-Jul 2026, fully resolved.
//
// The breakthrough: get_transaction_ledger_invtys accepts an `include` param that joins the
// related item / location / department onto each line -- so we get the real item CODE, location
// NAME and department NAME directly (get_inventories, which we'd otherwise need for the item pk,
// is unusable/times out). The adjustment's offsetting account comes from the header's
// SysFK_COA_TransH mapped through get_chart_of_accounts.
//
//   get_inventory_adjustments {searchKey,limit,offset}                 -> header list
//   get_transactions {where:{SysPK_TransH:pk}}                         -> header (SysFK_COA_TransH)
//   get_transaction_ledger_invtys {where:{SysFK_TransH_LdgrInvty:pk},
//       include:['transactionledgerinvty_invty','..._location','..._department']} -> lines + joins
//
// GL: glImpact posts status='approved' adjustments from the line items' asset accounts +
// est_unit_cost and the header adjustment account -- all now populated, so GL matches live.
// Resumable + idempotent.
//   node src/db/import-inventory-adjustments.js --from=2026-01-01 --to=2026-07-31
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
function argVal(name, def) { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; }
// Defaults to everything. The original run was scoped to Jan-Jul 2026 and left the other
// years unimported; a window this wide is a no-op filter, and the date args remain for
// re-running a single period.
const FROM = argVal('from', '2000-01-01');
const TO = argVal('to', '2099-12-31');
const CONCURRENCY = 3;
const DEFAULT_BASE_UNIT = 1;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clean = (v) => (v == null ? null : String(v).trim() || null);
const trunc = (v, n) => (v == null ? null : String(v).slice(0, n));
const day = (v) => (v || '').toString().slice(0, 10);
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase());
const normWs = (s) => norm(s).replace(/[\s-]+/g, '');
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
function adjStatus(live) {
  const s = (live || '').toLowerCase();
  if (s.includes('void') || s.includes('cancel')) return 'cancelled';
  if (s.includes('pending')) return 'pending';
  if (s.includes('approv')) return 'approved';
  return s || 'pending';
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Inventory Adjustments (include-resolved) | window ${FROM}..${TO}\n`);

  // Local resolution tables.
  const [invs] = await pool.query('SELECT id, item_code, display_name FROM inventories');
  const invByCode = new Map(); const invByName = new Map();
  for (const it of invs) { const c = norm(it.item_code); if (c && !invByCode.has(c)) invByCode.set(c, it.id); const n = norm(it.display_name); if (n && !invByName.has(n)) invByName.set(n, it.id); }
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [normWs(l.location_name), l.id]));
  const [deps] = await pool.query('SELECT id, name FROM departments');
  const depByName = new Map(deps.map((d) => [normWs(d.name), d.id]));
  const [coas] = await pool.query('SELECT id, account_code FROM chart_of_accounts');
  const coaByCode = new Map(coas.map((c) => [String(c.account_code), c.id]));

  let itemCreated = 0;
  const itemInflight = new Map();
  async function resolveItem(code, displayName) {
    const ck = norm(code);
    if (ck && invByCode.has(ck)) return invByCode.get(ck);
    const nk = norm(displayName); if (nk && invByName.has(nk)) return invByName.get(nk);
    if (!ck) return null;
    if (itemInflight.has(ck)) return itemInflight.get(ck);
    const run = (async () => {
      const [[row]] = await pool.query('SELECT id FROM inventories WHERE LOWER(item_code) = ? LIMIT 1', [ck]);
      let id = row ? row.id : null;
      if (!id) { const [r] = await pool.query('INSERT INTO inventories (item_code, display_name, base_unit_id, is_with_jo, is_po, is_jo) VALUES (?,?,?,0,0,0)', [trunc(code, 100), trunc(clean(displayName) || code, 255), DEFAULT_BASE_UNIT]); id = r.insertId; itemCreated += 1; }
      invByCode.set(ck, id); return id;
    })();
    itemInflight.set(ck, run); return run;
  }

  // Live COA pk -> code (to resolve the header adjustment account).
  const token = await login();
  const coaPkToCode = new Map();
  for (let off = 0; off < 20000; off += 200) {
    const list = listRows(await apiRetry(token, 'get_chart_of_accounts', { searchKey: '', limit: 200, offset: off }));
    if (!list.length) break;
    for (const c of list) if (c.SysPK_COA && c.UserPK_COA) coaPkToCode.set(c.SysPK_COA, String(c.UserPK_COA));
    if (list.length < 200) break;
  }
  console.log(`Loaded ${coaPkToCode.size} live COA(s).`);

  const [have] = await pool.query('SELECT adjustment_no FROM inventory_adjustments');
  const haveAdj = new Set(have.map((r) => r.adjustment_no));

  // Page adjustment headers in the window.
  //
  // Paged to exhaustion, and a failed page is skipped rather than ending the walk. Both
  // matter: live returns a short page transiently under load, and stopping on the first one
  // silently truncates the import while still reporting a clean finish -- that cost 23,000
  // item receipts before it was caught. A single failed page used to `break` here, which
  // would drop every remaining adjustment for one timeout.
  const adjs = [];
  let emptyStreak = 0;
  for (let offset = 0; offset < 120000; offset += 200) {
    let list = [];
    try { list = listRows(await apiRetry(token, 'get_inventory_adjustments', { searchKey: '', limit: 200, offset })); }
    catch (e) { console.warn(`  page ${offset} failed: ${e.message}`); }
    if (!list.length) {
      emptyStreak += 1;
      if (emptyStreak >= 2) break;
      continue;
    }
    emptyStreak = 0;
    for (const a of list) { const d = day(a.DateCreated_TransH); if (d >= FROM && d <= TO) adjs.push(a); }
  }
  const targets = adjs.filter((a) => !haveAdj.has(a.UserPK_TransH));
  console.log(`Found ${adjs.length} adjustment(s) in window; ${targets.length} to import.\n`);

  let done = 0, lineCount = 0, itemMiss = 0, failed = 0;
  await mapWithConcurrency(targets, CONCURRENCY, async (a) => {
    let header, lines;
    try {
      header = listRows(await apiRetry(token, 'get_transactions', { where: { SysPK_TransH: a.SysPK_TransH } }))[0] || a;
      lines = listRows(await apiRetry(token, 'get_transaction_ledger_invtys', {
        where: { SysFK_TransH_LdgrInvty: a.SysPK_TransH },
        include: ['transactionledgerinvty_invty', 'transactionledgerinvty_location', 'transactionledgerinvty_department'],
      }));
    } catch (e) { failed += 1; return; }

    const adjAccountId = coaByCode.get(coaPkToCode.get(header.SysFK_COA_TransH)) || null;

    const prepared = [];
    for (const l of lines) {
      const inv = l.transactionledgerinvty_invty;
      const itemId = await resolveItem(inv?.UserPK_Invty, inv?.DisplayName_Invty || l.DisplayDescription_LdgrInvty);
      if (!itemId) { itemMiss += 1; continue; } // no code at all -> skip (rare)
      const locId = locByName.get(normWs(l.transactionledgerinvty_location?.Name_Loc)) || null;
      const depId = depByName.get(normWs(l.transactionledgerinvty_department?.Name_Dept)) || null;
      prepared.push({ l, itemId, locId, depId });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO inventory_adjustments (adjustment_no, date_created, adjustment_account_id, memo, estimated_total_value, status)
         VALUES (?,?,?,?,?,?)`,
        [a.UserPK_TransH, day(a.DateCreated_TransH) || FROM, adjAccountId, trunc(a.Memo_TransH, 500), num(a.TotalAmount_TransH), adjStatus(a.Status_TransH)]);
      const adjId = r.insertId;
      let seq = 0;
      for (const { l, itemId, locId, depId } of prepared) {
        seq += 1;
        const cost = num(l.Cost_LdgrInvty) || num(l.Rate_LdgrInvty);
        await conn.query(
          `INSERT INTO inventory_adjustment_lines
             (inventory_adjustment_id, line_no, item_id, location_id, department_id, qty_on_hand, unit,
              current_value, adjust_qty_by, new_qty, est_unit_cost, memo, unit_used)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [adjId, seq, itemId, locId, depId, num(l.QtyOnHand_LdgrInvty), trunc(l.UnitOfMeasure_LdgrInvty, 30),
           cost, num(l.AdjustQty_LdgrInvty), num(l.NewQty_LdgrInvty), cost,
           trunc(l.Particulars_LdgrInvty || l.Memo_LdgrInvty, 500), trunc(l.UnitUsed_LdgrInvty, 30)]);
        lineCount += 1;
      }
      await conn.commit();
      haveAdj.add(a.UserPK_TransH);
      done += 1;
      if (done % 25 === 0) console.log(`  ...${done}/${targets.length} adjustments (${lineCount} lines)`);
    } catch (e) { await conn.rollback(); failed += 1; if (failed <= 5) console.error(`  [error] ${a.UserPK_TransH}: ${e.message}`); }
    finally { conn.release(); }
  });

  console.log(`\nDone. ${done} adjustment(s), ${lineCount} line(s). Items created: ${itemCreated}. Lines skipped (no item code): ${itemMiss}. Failures: ${failed}.`);
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
