// Put Transfer Order / Item Fulfillment / Item Receipt lines that landed on the MISC-PO
// placeholder back on their real item (asked 2026-10-06: TO-39147 line 3 read "MISC-PO -- Non-
// inventory / service PO line" where the source has STAINLESS SCREW 8 MM X 1").
//
// HOW THEY GOT THERE. import-purchase-orders.js matched source items to T1S by exact item code and
// sent anything it could not match to MISC-PO -- writing that choice into live_item_pk_map, the
// source-item -> T1S-item table. 589 source items are mapped to MISC-PO there, and
// import-transfer-chain.js trusted the table: 3,371 TO lines, 3,368 fulfilment lines and 3,310
// receipt lines. Many of those items exist in T1S under a code that differs only in its quotes or
// spacing (SIGN-SCRW-STAINLESS 8MM X 1'' against the source's 8MM X 1").
//
// WHAT THIS DOES.
//   1. Each source item mapped to MISC-PO is looked up on the source (code, display name) and
//      matched to T1S: exact code, then code ignoring quotes and spaces, then display name the same
//      way. A loose match is taken only when it names exactly ONE T1S item; anything else stays.
//   2. The source's Transfer Orders are paged (their lines carry the item) to learn which item each
//      MISC-PO TO line really is, by the line's own source key (transfer_order_lines.live_pk).
//      Cached in .live-cache/, so --apply does not fetch again.
//   3. --apply: those TO lines take their item, the fulfilment and receipt lines hanging off them
//      follow, and live_item_pk_map is corrected so a re-import cannot put them back. Purchase
//      Order lines on MISC-PO are left alone -- a PO genuinely bills non-inventory services there.
//
// Fulfilments and receipts are stock movements: after 2026-10-01 (the ledger's anchor) a corrected
// line moves the real item's Bin Card instead of MISC-PO's.
//
// Dry run unless --apply; --apply writes a rollback file first. --refresh re-fetches the source.
// Production: the droplet only (replication carries it to the office).
//
//   node src/db/remap-misc-po-items.js [--refresh] [--apply]
//   node src/db/remap-misc-po-items.js --rollback=rollback/misc-po-remap-rollback-<stamp>.json
const fs = require('fs');
const path = require('path');
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const PAGE = 200;
const APPLY = process.argv.includes('--apply');
const REFRESH = process.argv.includes('--refresh');
const ROLLBACK = (process.argv.find((a) => a.startsWith('--rollback=')) || '').split('=').slice(1).join('=');
const CACHE_DIR = path.join(__dirname, '..', '..', '.live-cache');
const CACHE = path.join(CACHE_DIR, 'misc-po-remap.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
// Quotes of every kind and all whitespace dropped: 8MM X 1'' and 8MM X 1" and 8mmx1 are one item.
const loose = (s) => norm(s).replace(/["'`‘’“”′″]/g, '').replace(/\s+/g, '');
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  const b = await r.json();
  if (!b?.data?.token) throw new Error(`Login failed: ${b?.message || 'no token'}`);
  return b.data.token;
}
async function api(token, ep, payload, attempts = 5) {
  let last;
  for (let a = 0; a < attempts; a += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000 + a * 20000);
    try {
      const r = await fetch(`${SITE}/api/${ep}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload), signal: ctl.signal,
      });
      const j = await r.json(); clearTimeout(timer); return j;
    } catch (e) { clearTimeout(timer); last = e; await sleep(1500 * (a + 1)); }
  }
  throw last;
}

async function fetchSource(miscPks, wantLinePks) {
  const token = await login();
  // 1. The source's own code and name for every item the table sends to MISC-PO.
  const items = {};
  let i = 0;
  for (const pk of miscPks) {
    i += 1;
    try {
      const r = listRows(await api(token, 'get_inventories', { where: { SysPK_Invty: pk }, limit: 1 }, 3))[0];
      items[pk] = r ? { code: r.UserPK_Invty || null, name: r.DisplayName_Invty || null } : null;
    } catch { items[pk] = null; }
    if (i % 100 === 0) console.log(`  items looked up: ${i}/${miscPks.length}`);
  }
  // 2. Which source item each of our MISC-PO TO lines is, from the source's TO lines. Paged to
  //    exhaustion (two empty pages end it), as import-transfer-chain.js does.
  const lineItem = {};
  const want = new Set(wantLinePks);
  let empty = 0;
  for (let off = 0; off < 400000 && Object.keys(lineItem).length < want.size; off += PAGE) {
    let rows = [];
    try {
      rows = listRows(await api(token, 'get_transactions', {
        where: { Module_TransH: 'TRANSFERORDER' }, include: ['transaction_transactionledgerinvtys'], limit: PAGE, offset: off,
      }));
    } catch (e) { console.warn(`  !! page ${off} failed: ${e.message}`); continue; }
    if (!rows.length) { empty += 1; if (empty >= 2) break; continue; }
    empty = 0;
    for (const h of rows) for (const l of h.transaction_transactionledgerinvtys || []) {
      if (want.has(l.SysPK_LdgrInvty)) lineItem[l.SysPK_LdgrInvty] = l.SysFK_Invty_LdgrInvty;
    }
    if ((off / PAGE) % 20 === 0) console.log(`  TO pages read: ${off / PAGE + 1}, lines found ${Object.keys(lineItem).length}/${want.size}`);
  }
  return { items, lineItem, fetched_at: new Date().toISOString() };
}

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- DRY RUN, nothing written'}`);
  if (ROLLBACK) {
    const rb = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const r of rb.lines) await conn.query(`UPDATE ${r.table} SET item_id = ? WHERE id = ?`, [r.item_id, r.id]);
      for (const m of rb.map) await conn.query('UPDATE live_item_pk_map SET item_id = ? WHERE live_item_pk = ?', [m.item_id, m.live_item_pk]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    console.log(`Rolled back ${rb.lines.length} line(s) and ${rb.map.length} map row(s).`);
    return;
  }

  const [[misc]] = await pool.query("SELECT id FROM inventories WHERE item_code = 'MISC-PO' LIMIT 1");
  if (!misc) throw new Error('No MISC-PO item.');
  const [mapRows] = await pool.query('SELECT live_item_pk FROM live_item_pk_map WHERE item_id = ?', [misc.id]);
  const miscPks = mapRows.map((r) => r.live_item_pk);
  const [toLines] = await pool.query(
    'SELECT id, live_pk, transfer_order_id FROM transfer_order_lines WHERE item_id = ? AND live_pk IS NOT NULL', [misc.id]);
  console.log(`Source items mapped to MISC-PO: ${miscPks.length}; TO lines on MISC-PO with a source key: ${toLines.length}`);

  let src = null;
  if (!REFRESH && fs.existsSync(CACHE)) {
    src = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    console.log(`Using the source data fetched ${src.fetched_at} (--refresh to fetch again).`);
  } else {
    console.log('Fetching from the source...');
    src = await fetchSource(miscPks, toLines.map((l) => l.live_pk));
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(src));
  }

  // Match source items to T1S.
  const [inv] = await pool.query('SELECT id, item_code, display_name FROM inventories WHERE id <> ?', [misc.id]);
  const index = (key) => {
    const m = new Map();
    for (const it of inv) { const k = key(it); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(it.id); }
    return m;
  };
  const byCode = index((it) => norm(it.item_code));
  const byLooseCode = index((it) => loose(it.item_code));
  const byLooseName = index((it) => loose(it.display_name));
  const one = (m, k) => (k && m.get(k)?.length === 1 ? m.get(k)[0] : null);
  const resolved = new Map(); const how = { code: 0, looseCode: 0, name: 0 }; const unmatched = [];
  for (const pk of miscPks) {
    const s = src.items[pk];
    if (!s) { unmatched.push({ pk, why: 'not found on the source' }); continue; }
    let id = one(byCode, norm(s.code)); let via = 'code';
    if (!id) { id = one(byLooseCode, loose(s.code)); via = 'looseCode'; }
    if (!id) { id = one(byLooseName, loose(s.name)); via = 'name'; }
    if (id) { resolved.set(pk, id); how[via] += 1; } else unmatched.push({ pk, code: s.code, name: s.name });
  }
  console.log(`Items matched: ${resolved.size}/${miscPks.length} (exact code ${how.code}, code ignoring quotes/spaces ${how.looseCode}, name ${how.name}); unmatched ${unmatched.length}`);

  const plan = []; let noSourceLine = 0; let itemUnmatched = 0;
  for (const l of toLines) {
    const srcItem = src.lineItem[l.live_pk];
    if (!srcItem) { noSourceLine += 1; continue; }
    const id = resolved.get(srcItem);
    if (!id) { itemUnmatched += 1; continue; }
    plan.push({ id: l.id, item_id: id });
  }
  const toIds = plan.map((p) => p.id);
  let ifCount = 0; let irCount = 0;
  if (toIds.length) {
    [[{ n: ifCount }]] = await pool.query('SELECT COUNT(*) AS n FROM item_fulfillment_lines WHERE item_id = ? AND transfer_order_line_id IN (?)', [misc.id, toIds]);
    [[{ n: irCount }]] = await pool.query('SELECT COUNT(*) AS n FROM item_receipt_lines WHERE item_id = ? AND transfer_order_line_id IN (?)', [misc.id, toIds]);
  }
  console.log(`TO lines to correct: ${plan.length} (no source line found ${noSourceLine}, item not matched ${itemUnmatched})`);
  console.log(`  with them: ${ifCount} fulfilment line(s), ${irCount} receipt line(s)`);
  const [names] = plan.length ? await pool.query('SELECT id, item_code FROM inventories WHERE id IN (?)', [[...new Set(plan.map((p) => p.item_id))]]) : [[]];
  const codeOf = new Map(names.map((n) => [n.id, n.item_code]));
  const [sample] = plan.length ? await pool.query(
    `SELECT tol.id, t.to_no, tol.line_no FROM transfer_order_lines tol JOIN transfer_orders t ON t.id = tol.transfer_order_id WHERE tol.id IN (?) ORDER BY t.id DESC LIMIT 8`,
    [toIds]) : [[]];
  const target = new Map(plan.map((p) => [p.id, p.item_id]));
  for (const s of sample) console.log(`    ${s.to_no} line ${s.line_no}: MISC-PO -> ${codeOf.get(target.get(s.id))}`);
  for (const u of unmatched.slice(0, 12)) console.log(`    UNMATCHED ${u.code || u.pk} ${u.name ? `(${u.name})` : u.why || ''}`);
  if (!APPLY) return;

  const outDir = path.join(__dirname, '..', '..', 'rollback'); fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `misc-po-remap-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const conn = await pool.getConnection();
  try {
    const [ifLines] = toIds.length ? await conn.query('SELECT id, transfer_order_line_id FROM item_fulfillment_lines WHERE item_id = ? AND transfer_order_line_id IN (?)', [misc.id, toIds]) : [[]];
    const [irLines] = toIds.length ? await conn.query('SELECT id, transfer_order_line_id FROM item_receipt_lines WHERE item_id = ? AND transfer_order_line_id IN (?)', [misc.id, toIds]) : [[]];
    const rb = {
      lines: [
        ...plan.map((p) => ({ table: 'transfer_order_lines', id: p.id, item_id: misc.id })),
        ...ifLines.map((r) => ({ table: 'item_fulfillment_lines', id: r.id, item_id: misc.id })),
        ...irLines.map((r) => ({ table: 'item_receipt_lines', id: r.id, item_id: misc.id })),
      ],
      map: [...resolved.keys()].map((pk) => ({ live_item_pk: pk, item_id: misc.id })),
    };
    fs.writeFileSync(file, JSON.stringify(rb)); // before anything changes
    await conn.beginTransaction();
    for (const p of plan) await conn.query('UPDATE transfer_order_lines SET item_id = ? WHERE id = ? AND item_id = ?', [p.item_id, p.id, misc.id]);
    for (const r of ifLines) await conn.query('UPDATE item_fulfillment_lines SET item_id = ? WHERE id = ?', [target.get(r.transfer_order_line_id), r.id]);
    for (const r of irLines) await conn.query('UPDATE item_receipt_lines SET item_id = ? WHERE id = ?', [target.get(r.transfer_order_line_id), r.id]);
    for (const [pk, id] of resolved) await conn.query('UPDATE live_item_pk_map SET item_id = ? WHERE live_item_pk = ? AND item_id = ?', [id, pk, misc.id]);
    await conn.commit();
    console.log(`Corrected ${plan.length} TO, ${ifLines.length} fulfilment and ${irLines.length} receipt line(s); ${resolved.size} map row(s). Rollback: ${file}`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
