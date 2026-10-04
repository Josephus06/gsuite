// READ-ONLY. T1S's Stock Ledger AND Bin Card against the source's Stock Ledger, as of a date.
//
// compare-stock-onhand.js already answers "is the on-hand right TODAY". This answers a different
// question: on a given date, do the two REPORTS agree with the source -- and they are two separate
// numbers, because the two reports reach a balance by different routes.
//
//   source   generate_stock_ledger_v2 over [--from, --as-of] -> EndingQty, in the STOCK unit
//            (0.267 ROLL, 6 SHT -- the source's Stock Ledger is kept in stock units)
//   ledger   T1S's Stock Ledger (routes/stockLedger.js): the snapshot's beg_qty plus every
//            movement from the snapshot date to the as-of date. Below the snapshot date that is
//            just beg_qty, since the window has not opened yet.
//   bincard  T1S's Bin Card (routes/binCard.js): the same anchored figure ONLY when the as-of
//            date is on or after the snapshot's window_from. Before it the anchor describes a
//            later moment than the question, so that report falls back to replaying the whole
//            migrated movement history from zero (`reconciled: false`) -- which is the figure
//            compared here, because it is what the screen actually shows.
//
// So with a snapshot struck on 2026-10-01 and --as-of=2026-09-30, `ledger` is expected to match
// the source and `bincard` is expected not to: that gap IS the finding, not a bug in this script.
//
// A pair counts as different when it disagrees by more than 0.001 of the stock unit.
//
//   node src/db/compare-stock-asof.js --as-of=2026-09-30 [--from=2026-01-01] [--out=diffs.json]
//                                     [--top=40] [--pause=1500] [--batch=25] [--db-pause=300]
//
// Run it after office hours: the source's Stock Ledger report is heavy (~40s a page), and T1S's
// movements are read --batch items at a time with --db-pause ms between so the droplet keeps
// serving. Nothing here writes to either system.
const fs = require('fs');
require('dotenv').config();
const pool = require('../db');
const { movementsSql } = require('../lib/stockLedger');

const SITE = 'http://gsuite.graphicstar.com.ph';
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const FROM = arg('from', '2026-01-01');
const OUT = arg('out', null);
const TOP = Number(arg('top', 40));
const PAGE = 100;
const PAUSE = Number(arg('pause', 1500)); // ms between source pages, so the old system is not hammered
const BATCH = Number(arg('batch', 25)); // items per T1S movement query
const DB_PAUSE = Number(arg('db-pause', 300)); // ms between those queries, so T1S keeps answering users
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase());
const normWs = (s) => norm(s).replace(/[\s-]+/g, '');
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
        body: JSON.stringify([cfg, [], [], { limit: PAGE, offset }]), signal: AbortSignal.timeout(240000 + a * 60000) });
      return await r.json();
    } catch (e) { if (a === 3) throw e; await sleep(2000 * (a + 1)); }
  }
  return null;
}

async function main() {
  const [[w]] = await pool.query("SELECT DATE_FORMAT(MIN(window_from), '%Y-%m-%d') AS f FROM live_stock_ledger");
  const WINDOW_FROM = w?.f || null;
  if (!WINDOW_FROM) { console.log('No stock-ledger snapshot (live_stock_ledger) on this install.'); return; }
  // Defaults to the day the snapshot's window opens on, minus one -- the balance the snapshot
  // itself represents, and the date this comparison is most often asked about.
  const AS_OF = arg('as-of', new Date(new Date(`${WINDOW_FROM}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10));
  const RECONCILED = AS_OF >= WINDOW_FROM;

  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Snapshot window opens ${WINDOW_FROM}; comparing as of ${AS_OF} (source period ${FROM}..${AS_OF})`);
  console.log(`Bin Card on that date: ${RECONCILED ? 'ANCHORED on the snapshot (same figure as the Stock Ledger)' : 'FULL history from zero -- the as-of date predates the snapshot'}\n`);

  // ---- T1S -----------------------------------------------------------------------------------
  const [items] = await pool.query(
    `SELECT i.id, i.item_code, i.display_name, COALESCE(NULLIF(i.conversion_factor, 0), 1) AS cf,
            su.code AS stock_code
       FROM inventories i LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id`);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const invByCode = new Map(); for (const it of items) { const c = norm(it.item_code); if (c && !invByCode.has(c)) invByCode.set(c, it.id); }
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [normWs(l.location_name), l.id]));
  const locName = new Map(locs.map((l) => [l.id, l.location_name]));

  // The snapshot, in STOCK units exactly as the source quotes it.
  const snapshot = new Map();
  const [snap] = await pool.query(
    `SELECT inventory_id, location_id, SUM(beg_qty) AS beg FROM live_stock_ledger
      WHERE inventory_id IS NOT NULL AND location_id IS NOT NULL
      GROUP BY inventory_id, location_id`);
  for (const r of snap) snapshot.set(`${r.inventory_id}|${r.location_id}`, Number(r.beg || 0));

  // Movements once, aggregated in SQL rather than returned row by row: net_all is every movement
  // up to the as-of date (what the unanchored Bin Card replays), net_window only those from the
  // snapshot date on (what the Stock Ledger adds to beg_qty). Both in BASE units.
  const netAll = new Map(); const netWindow = new Map();
  const ids = items.map((i) => i.id);
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const [rows] = await pool.query(
      `SELECT m.item_id, COALESCE(m.to_location_id, m.from_location_id) AS location_id,
              SUM(m.qty_in - m.qty_out) AS net_all,
              SUM(IF(m.trans_date >= ?, m.qty_in - m.qty_out, 0)) AS net_window
         FROM (${movementsSql(true)}) m
        WHERE m.trans_date <= ?
        GROUP BY 1, 2`,
      [WINDOW_FROM, chunk, chunk, chunk, chunk, chunk, chunk, AS_OF]);
    for (const r of rows) {
      if (r.location_id == null) continue;
      const k = `${r.item_id}|${r.location_id}`;
      netAll.set(k, Number(r.net_all || 0));
      netWindow.set(k, Number(r.net_window || 0));
    }
    process.stdout.write(`\r  T1S movements: ${Math.min(i + BATCH, ids.length)}/${ids.length} items`);
    await sleep(DB_PAUSE);
  }
  process.stdout.write('\n');
  console.log(`T1S: ${snapshot.size} snapshot pairs, ${netAll.size} pairs with movements up to ${AS_OF}`);

  // ---- source --------------------------------------------------------------------------------
  const token = await login();
  if (!token) throw new Error('Source login failed');
  const [ty, tm, td] = AS_OF.split('-').map(Number);
  const cfg = { filter: 'period from',
    date1: { hide: false, label: 'Date From', date: new Date(`${FROM}T00:00:00+08:00`).toISOString() },
    date2: { hide: false, label: 'Date To', date: `${MONTHS[tm - 1]} ${td}, ${ty}` } };
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

  // ---- compare, in the STOCK unit -------------------------------------------------------------
  const pairs = new Set([...snapshot.keys(), ...netAll.keys(), ...src.keys()]);
  const diffs = [];
  let ledgerSame = 0; let binSame = 0; let bothZero = 0;
  for (const k of pairs) {
    const [itemId, locId] = k.split('|').map(Number);
    const it = itemById.get(itemId); if (!it) continue;
    const cf = Number(it.cf);
    const theirs = r4(src.get(k) || 0);
    const ledger = r4((snapshot.get(k) || 0) + (netWindow.get(k) || 0) / cf);
    const bincard = RECONCILED ? ledger : r4((netAll.get(k) || 0) / cf);
    const ledgerOk = Math.abs(ledger - theirs) <= 0.001;
    const binOk = Math.abs(bincard - theirs) <= 0.001;
    if (ledgerOk) ledgerSame += 1;
    if (binOk) binSame += 1;
    if (ledgerOk && binOk) { if (!theirs) bothZero += 1; continue; }
    diffs.push({ item_code: it.item_code, item: it.display_name, location: locName.get(locId),
      unit: it.stock_code || '', cf, source: theirs, ledger, bincard,
      ledger_gap: r4(ledger - theirs), bincard_gap: r4(bincard - theirs),
      which: ledgerOk ? 'bin card only' : binOk ? 'stock ledger only' : 'both' });
  }
  const compared = pairs.size;
  const negative = [...netAll.values()].filter((v) => v < -0.0005).length;
  console.log(`Item/location pairs compared: ${compared}  (${bothZero} of them zero on both sides)`);
  console.log(`  Stock Ledger matches the source: ${ledgerSame}  (differs on ${compared - ledgerSame})`);
  console.log(`  Bin Card     matches the source: ${binSame}  (differs on ${compared - binSame})`);
  console.log(`  disagreeing on both reports: ${diffs.filter((d) => d.which === 'both').length}`);
  console.log(`  pairs the migrated history alone puts NEGATIVE: ${negative}`);

  const worstLedger = diffs.filter((d) => Math.abs(d.ledger_gap) > 0.001)
    .sort((a, b) => Math.abs(b.ledger_gap * b.cf) - Math.abs(a.ledger_gap * a.cf));
  console.log(`\nLargest ${Math.min(TOP, worstLedger.length)} STOCK LEDGER differences (stock unit):`);
  for (const d of worstLedger.slice(0, TOP)) {
    console.log(`  ${d.item_code} @ ${d.location}: T1S ${d.ledger} vs source ${d.source} ${d.unit} (gap ${d.ledger_gap})`);
  }
  if (!worstLedger.length) console.log('  none -- the Stock Ledger agrees with the source on every pair.');

  const worstBin = diffs.filter((d) => Math.abs(d.bincard_gap) > 0.001)
    .sort((a, b) => Math.abs(b.bincard_gap * b.cf) - Math.abs(a.bincard_gap * a.cf));
  console.log(`\nLargest ${Math.min(TOP, worstBin.length)} BIN CARD differences (stock unit):`);
  for (const d of worstBin.slice(0, TOP)) {
    console.log(`  ${d.item_code} @ ${d.location}: T1S ${d.bincard} vs source ${d.source} ${d.unit} (gap ${d.bincard_gap})`);
  }
  if (!worstBin.length) console.log('  none -- the Bin Card agrees with the source on every pair.');

  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(diffs, null, 1)); console.log(`\nAll ${diffs.length} differing pairs -> ${OUT}`); }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
