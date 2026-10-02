// READ-ONLY. Every item / location's on-hand in T1S against the source's own Stock Ledger, as of a
// date, with the movements behind each pair that disagrees.
//
//   source  generate_stock_ledger_v2 over [snapshot date, as-of] -> EndingQty, in the STOCK unit
//           (0.267 ROLL, 6 SHT -- the source's Stock Ledger is kept in stock units)
//   T1S     the snapshot's Beginning (live_stock_ledger.beg_qty x conversion) + T1S's movements from
//           the snapshot date to as-of (lib/stockLedger.js movementsSql, Base Unit), divided back to
//           the stock unit -- exactly how deriveOnHand and the Bin Card arrive at it
//
// A pair counts as different when the two disagree by more than 0.001 of the stock unit. For each,
// the movements since the snapshot are listed with their document unit, and the gap is tested for
// the shapes a unit mistake leaves: the gap equal to one movement's quantity x (conversion - 1)
// (posted unconverted) or / conversion (converted twice).
//
//   node src/db/compare-stock-onhand.js [--as-of=YYYY-MM-DD] [--out=stock-diffs.json] [--top=40] [--pause=1500]
// Heavy on the source's Stock Ledger report: run it after office hours.
const fs = require('fs');
const pool = require('../db');
require('dotenv').config();
const { movementsSql } = require('../lib/stockLedger');

const SITE = 'http://gsuite.graphicstar.com.ph';
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const AS_OF = arg('as-of', new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)); // PH date
const OUT = arg('out', null);
const TOP = Number(arg('top', 40));
const PAGE = 100;
const PAUSE = Number(arg('pause', 1500)); // ms between source pages, so the old system is not hammered
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase());
const normWs = (s) => norm(s).replace(/[\s-]+/g, '');
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  return (await r.json())?.data?.token;
}
async function ledgerPage(token, cfg, offset) {
  for (let a = 0; a < 4; a += 1) {
    try {
      const r = await fetch(`${SITE}/api/generate_stock_ledger_v2`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify([cfg, [], [], { limit: PAGE, offset }]), signal: AbortSignal.timeout(180000 + a * 60000) });
      return await r.json();
    } catch (e) { if (a === 3) throw e; await sleep(2000 * (a + 1)); }
  }
  return null;
}

async function main() {
  const [[w]] = await pool.query('SELECT MIN(window_from) AS f FROM live_stock_ledger');
  const FROM = w?.f ? String(w.f instanceof Date ? w.f.toISOString() : w.f).slice(0, 10) : null;
  if (!FROM) { console.log('No stock-ledger snapshot (live_stock_ledger) on this install.'); return; }
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- snapshot ${FROM}, comparing as of ${AS_OF}\n`);

  // ---- T1S ---------------------------------------------------------------------------------
  const [items] = await pool.query(
    `SELECT i.id, i.item_code, i.display_name, COALESCE(NULLIF(i.conversion_factor, 0), 1) AS cf,
            su.code AS stock_code, bu.code AS base_code
       FROM inventories i LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id LEFT JOIN units_of_measure bu ON bu.id = i.base_unit_id`);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const invByCode = new Map(); for (const it of items) { const c = norm(it.item_code); if (c && !invByCode.has(c)) invByCode.set(c, it.id); }
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [normWs(l.location_name), l.id]));
  const locName = new Map(locs.map((l) => [l.id, l.location_name]));

  const t1s = new Map(); // pair -> base qty
  const [snap] = await pool.query(
    `SELECT inventory_id, location_id, beg_qty FROM live_stock_ledger
      WHERE inventory_id IS NOT NULL AND location_id IS NOT NULL AND window_from = ?`, [FROM]);
  for (const r of snap) {
    const it = itemById.get(r.inventory_id); if (!it) continue;
    const k = `${r.inventory_id}|${r.location_id}`;
    t1s.set(k, (t1s.get(k) || 0) + Number(r.beg_qty || 0) * Number(it.cf));
  }
  const [moves] = await pool.query(
    `SELECT m.item_id, COALESCE(m.to_location_id, m.from_location_id) AS location_id, m.trans_date, m.trans_no, m.trans_type,
            m.qty_in, m.qty_out, m.doc_uom, m.uom
       FROM (${movementsSql(false)}) m
      WHERE m.trans_date >= ? AND m.trans_date <= ?`, [FROM, AS_OF]);
  const movesByPair = new Map();
  for (const m of moves) {
    if (m.location_id == null) continue;
    const k = `${m.item_id}|${m.location_id}`;
    t1s.set(k, (t1s.get(k) || 0) + Number(m.qty_in || 0) - Number(m.qty_out || 0));
    if (!movesByPair.has(k)) movesByPair.set(k, []);
    movesByPair.get(k).push(m);
  }
  console.log(`T1S: ${snap.length} snapshot pairs, ${moves.length} movements since ${FROM}`);

  // ---- source ------------------------------------------------------------------------------
  const token = await login();
  if (!token) throw new Error('Source login failed');
  const date1ISO = new Date(`${FROM}T00:00:00+08:00`).toISOString();
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [ty, tm, td] = AS_OF.split('-').map(Number);
  const cfg = { filter: 'period from', date1: { hide: false, label: 'Date From', date: date1ISO }, date2: { hide: false, label: 'Date To', date: `${MONTHS[tm - 1]} ${td}, ${ty}` } };
  const src = new Map(); let total = null; let unresolved = 0;
  for (let offset = 0; ; offset += PAGE) {
    const resp = await ledgerPage(token, cfg, offset);
    const data = resp?.data;
    if (!Array.isArray(data)) throw new Error(`source page at ${offset} returned no data`);
    if (total === null) total = data[0];
    const rows = (Array.isArray(data[1]) ? data[1] : []).filter((r) => r.Location);
    for (const r of rows) {
      const invId = invByCode.get(norm(r.ItemCode)); const locId = locByName.get(normWs(r.Location));
      if (!invId || !locId) { unresolved += 1; continue; }
      const k = `${invId}|${locId}`;
      src.set(k, (src.get(k) || 0) + Number(r.EndingQty || 0));
    }
    process.stdout.write(`\r  source: ${Math.min(offset + PAGE, total || 0)}/${total} items read`);
    if (offset + PAGE >= (total || 0)) break;
    await sleep(PAUSE);
  }
  console.log(`\nSource: ${src.size} item/location pairs (${unresolved} rows not matched to a T1S item/location)\n`);

  // ---- compare, in the STOCK unit ------------------------------------------------------------
  const pairs = new Set([...t1s.keys(), ...src.keys()]);
  const diffs = []; let same = 0; let negative = 0;
  for (const k of pairs) {
    const [itemId, locId] = k.split('|').map(Number);
    const it = itemById.get(itemId); if (!it) continue;
    const cf = Number(it.cf);
    const mine = r4((t1s.get(k) || 0) / cf);
    const theirs = r4(src.get(k) || 0);
    if (mine < -0.0005) negative += 1;
    if (Math.abs(mine - theirs) <= 0.001) { same += 1; continue; }
    const gap = r4(mine - theirs);
    const mv = (movesByPair.get(k) || []).map((m) => ({
      date: String(m.trans_date).slice(0, 10), doc: m.trans_no, type: m.trans_type,
      base_in: r4(m.qty_in), base_out: r4(m.qty_out), doc_uom: m.doc_uom || m.uom || null,
    }));
    // Unit-mistake shapes: one movement whose quantity, mis-scaled, accounts for the whole gap.
    let suspect = null;
    if (cf > 1) {
      // q = the Base quantity T1S recorded. Posted unconverted: the true Base was q x cf, so the
      // stock-unit gap is q(cf-1)/cf. Converted once too often: the true Base was q / cf, gap q(cf-1)/cf^2.
      const near = (x) => Math.abs(Math.abs(x) - Math.abs(gap)) <= Math.max(0.01, Math.abs(gap) * 0.005);
      for (const m of mv) {
        const q = Math.abs((m.base_in || 0) - (m.base_out || 0));
        if (!q) continue;
        if (near((q * (cf - 1)) / cf)) { suspect = `${m.doc} looks posted unconverted (${m.doc_uom || '?'})`; break; }
        if (near((q * (cf - 1)) / cf / cf)) { suspect = `${m.doc} looks converted twice (${m.doc_uom || '?'})`; break; }
      }
    }
    diffs.push({ item_code: it.item_code, item: it.display_name, location: locName.get(locId), unit: it.stock_code || '', cf,
      t1s: mine, source: theirs, gap, suspect, movements_since: mv.length, movements: mv.slice(0, 12) });
  }
  diffs.sort((a, b) => Math.abs(b.gap * b.cf) - Math.abs(a.gap * a.cf));
  console.log(`Item/location pairs compared: ${same + diffs.length}`);
  console.log(`  same as the source: ${same}`);
  console.log(`  different:          ${diffs.length}  (with a T1S movement since ${FROM}: ${diffs.filter((d) => d.movements_since).length}; with none: ${diffs.filter((d) => !d.movements_since).length})`);
  console.log(`  negative in T1S:    ${negative}`);
  console.log(`  looking like a unit mistake: ${diffs.filter((d) => d.suspect).length}`);
  console.log(`\nLargest ${Math.min(TOP, diffs.length)} differences (stock unit):`);
  for (const d of diffs.slice(0, TOP)) {
    console.log(`  ${d.item_code} @ ${d.location}: T1S ${d.t1s} vs source ${d.source} ${d.unit} (gap ${d.gap})${d.suspect ? `  <- ${d.suspect}` : ''}`);
    for (const m of d.movements.slice(0, 4)) console.log(`      ${m.date} ${m.type} ${m.doc}: in ${m.base_in} out ${m.base_out} (base) doc unit ${m.doc_uom || '-'}`);
  }
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(diffs, null, 1)); console.log(`\nAll ${diffs.length} differences -> ${OUT}`); }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
