// Seeds inventory_locations -- the per item + location on-hand snapshot every stock screen
// reads -- from the source system's Stock Ledger (Inventory > Inventory Reports > Stock
// Ledger), which is the only place live publishes an absolute on-hand figure per warehouse.
//
// WHY THIS IS NEEDED: the year migrations brought over transactions (Assembly Builds,
// Receiving Reports, Fulfillments, ...) but never seeded the snapshot table, so it holds a
// dozen rows for a 4,000-item catalogue. Every read path treats a missing row as zero --
// production.js's Processes tab joins it LEFT and the client's qty() prints Number(null) as
// "0.0000" -- so a JO line for an item with 15 rolls in the warehouse reads as a full
// materials shortage, while Bin Card (which derives a balance from the transactions instead
// of reading the snapshot) happily shows stock. Seeding the table is what makes those two
// screens agree.
//
// SOURCE OF TRUTH: live_stock_ledger.ending_qty, staged verbatim by import-stock-ledger.js.
// Ending Qty is quoted in the item's STOCK unit -- live labels a converted item's rows
// "ROLL-LINCH-19680" (stock-base-factor), and the embedded factor matches
// inventories.conversion_factor on every single staged row -- while qty_on_hand is Base Unit
// everywhere in this build (purchaseOrders.js scales receipts up by conversion_factor before
// touching stock, and Bin Card divides back down to show a Stock Unit balance). So the figure
// written here is ending_qty * conversion_factor.
//
// Item codes and location names are re-resolved against the current masters rather than
// trusting live_stock_ledger's stored ids: those were resolved when the ledger was imported,
// and locations added since (Warehouse - Subcon, Warehouse - Technical) are left null there
// while they resolve fine today.
//
// EXISTING ROWS ARE LEFT ALONE by default. The snapshot is only as fresh as the last Stock
// Ledger import, whereas any row this build already wrote (an approved Inventory Adjustment,
// a PO receipt, an Assembly Build) reflects movement that may have happened after it --
// overwriting would silently roll that back. --overwrite makes it a full mirror instead.
// qty_committed / qty_in_transit are never touched: live's Stock Ledger doesn't report them.
//
// Negative Ending Qty is written as-is (198 staged rows are negative). That is live's own
// figure for those bins, and quietly flooring it at zero would hide a real data problem.
//
//   node src/db/backfill-inventory-locations.js --dry-run     # report, change nothing
//   node src/db/backfill-inventory-locations.js               # insert missing pairs
//   node src/db/backfill-inventory-locations.js --refresh     # re-pull the ledger first
//   node src/db/backfill-inventory-locations.js --overwrite   # full mirror of the snapshot
//   node src/db/backfill-inventory-locations.js --env=railway # run against .env.railway
const path = require('path');

function argVal(name, def) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
}

// The base .env carries the live-site credentials --refresh needs; --env overlays a different
// database on top of them. Loaded before ../db is required, since the pool reads process.env
// at require time and dotenv never overrides a value that is already set.
require('dotenv').config();
const ENV_NAME = argVal('env', null);
if (ENV_NAME) {
  const envPath = path.join(__dirname, '..', '..', `.env.${ENV_NAME}`);
  const loaded = require('dotenv').config({ path: envPath, override: true });
  if (loaded.error) { console.error(`Cannot read ${envPath}: ${loaded.error.message}`); process.exit(1); }
}

const { spawnSync } = require('child_process');
const pool = require('../db');
const { isNonStockItem } = require('../lib/itemTypes');

const DRY_RUN = process.argv.includes('--dry-run');
const OVERWRITE = process.argv.includes('--overwrite');
const NONZERO_ONLY = process.argv.includes('--nonzero-only');
const REFRESH = process.argv.includes('--refresh');
const STALE_DAYS = Number(argVal('stale-days', 7));
const BATCH = 500;

// Same normalisation import-stock-ledger.js resolves with, so this script agrees with it
// about which live name means which local row.
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase());
const normWs = (s) => norm(s).replace(/[\s-]+/g, '');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const phToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());

function listSample(values, limit = 12) {
  const shown = values.slice(0, limit).map((v) => `    - ${v}`).join('\n');
  const rest = values.length > limit ? `\n    ... and ${values.length - limit} more` : '';
  return shown + rest;
}

async function main() {
  console.log(`Target DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${ENV_NAME ? ` (--env=${ENV_NAME})` : ''}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}${OVERWRITE ? ' + OVERWRITE existing rows' : ''}${NONZERO_ONLY ? ' + non-zero only' : ''}\n`);

  const [[hasTable]] = await pool.query("SHOW TABLES LIKE 'live_stock_ledger'");
  if (!hasTable && !REFRESH) {
    console.error('live_stock_ledger does not exist. Stage the source snapshot first:');
    console.error('  node src/db/import-stock-ledger.js --to=<YYYY-MM-DD>   (or re-run this with --refresh)');
    process.exit(1);
  }

  if (REFRESH) {
    const to = argVal('to', phToday());
    const from = argVal('from', null);
    const args = [path.join(__dirname, 'import-stock-ledger.js'), `--to=${to}`];
    if (from) args.push(`--from=${from}`);
    console.log(`Refreshing the source snapshot: import-stock-ledger.js --to=${to}${from ? ` --from=${from}` : ''}\n`);
    const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
    if (r.status !== 0) { console.error('\nStock Ledger import failed -- nothing seeded.'); process.exit(1); }
    console.log('');
  }

  const [[snap]] = await pool.query(
    'SELECT COUNT(*) AS rows_ct, MAX(updated_at) AS as_of FROM live_stock_ledger'
  );
  if (!snap.rows_ct) {
    console.error('live_stock_ledger is empty -- run import-stock-ledger.js (or --refresh) first.');
    process.exit(1);
  }
  const ageDays = snap.as_of ? Math.floor((Date.now() - new Date(snap.as_of).getTime()) / 86400000) : null;
  console.log(`Source snapshot: ${snap.rows_ct} ledger row(s), imported ${snap.as_of} (${ageDays} day(s) ago)`);
  if (ageDays != null && ageDays > STALE_DAYS) {
    console.log(`  WARNING: that is older than ${STALE_DAYS} days. Anything received or consumed in live since`);
    console.log('           then is not in it. Re-run with --refresh for a current snapshot.');
  }
  console.log('');

  // Re-resolve against today's masters instead of the ids frozen into live_stock_ledger.
  const [invs] = await pool.query('SELECT id, item_code, display_name, item_type, conversion_factor FROM inventories');
  const invById = new Map(invs.map((i) => [i.id, i]));
  const invByCode = new Map();
  for (const i of invs) { const c = norm(i.item_code); if (c && !invByCode.has(c)) invByCode.set(c, i); }
  const [locs] = await pool.query('SELECT id, location_code, location_name FROM locations');
  const locById = new Map(locs.map((l) => [l.id, l]));
  const locByName = new Map();
  for (const l of locs) {
    const n = normWs(l.location_name); if (n && !locByName.has(n)) locByName.set(n, l.id);
    const c = normWs(l.location_code); if (c && !locByName.has(c)) locByName.set(c, l.id);
  }

  const [ledger] = await pool.query(
    `SELECT item_code, location, unit_title, ending_qty, inventory_id AS stored_item, location_id AS stored_loc
     FROM live_stock_ledger`
  );

  const wanted = new Map(); // "invId|locId" -> { invId, locId, qtyBase, item, loc, endingQty }
  const skipped = { noItem: new Set(), noLoc: new Set(), nonStock: new Set(), zero: 0, merged: [] };

  for (const r of ledger) {
    const item = invByCode.get(norm(r.item_code)) || invById.get(r.stored_item) || null;
    if (!item) { skipped.noItem.add(r.item_code); continue; }
    const locId = locByName.get(normWs(r.location)) || r.stored_loc || null;
    if (!locId) { skipped.noLoc.add(r.location); continue; }
    // A Service line has no shelf anywhere, so it gets no stock row (the Processes tab prints
    // "—" for it rather than a quantity). Live's ledger holds only INVENTORY/JIT rows today;
    // this guard keeps that true if that ever changes.
    if (isNonStockItem(item.item_type)) { skipped.nonStock.add(item.item_code); continue; }

    const factor = num(item.conversion_factor) || 1;
    const qtyBase = Math.round(num(r.ending_qty) * factor * 10000) / 10000;
    if (NONZERO_ONLY && qtyBase === 0) { skipped.zero += 1; continue; }

    const key = `${item.id}|${locId}`;
    const prev = wanted.get(key);
    if (prev) {
      // Two live item PKs sharing one local item code: their bins are the same shelf here.
      skipped.merged.push(`${item.item_code} @ ${locById.get(locId)?.location_name || locId}`);
      prev.qtyBase = Math.round((prev.qtyBase + qtyBase) * 10000) / 10000;
      continue;
    }
    wanted.set(key, { invId: item.id, locId, qtyBase, item, locName: locById.get(locId)?.location_name || String(locId) });
  }

  const [existingRows] = await pool.query('SELECT inventory_id, location_id, qty_on_hand FROM inventory_locations');
  const existing = new Map(existingRows.map((e) => [`${e.inventory_id}|${e.location_id}`, num(e.qty_on_hand)]));

  const toInsert = [];
  const toUpdate = [];
  const leftAlone = [];
  for (const [key, w] of wanted) {
    if (!existing.has(key)) { toInsert.push(w); continue; }
    const current = existing.get(key);
    if (current === w.qtyBase) continue; // already agrees -- nothing to do either way
    (OVERWRITE ? toUpdate : leftAlone).push({ ...w, current });
  }

  console.log('Resolution');
  console.log(`  ledger rows read ............ ${ledger.length}`);
  console.log(`  item+location pairs wanted .. ${wanted.size}`);
  if (skipped.noItem.size) {
    console.log(`  skipped, item code not in this catalogue .. ${skipped.noItem.size}`);
    console.log(listSample([...skipped.noItem]));
  }
  if (skipped.noLoc.size) {
    console.log(`  skipped, location not in this catalogue .. ${skipped.noLoc.size}`);
    console.log(listSample([...skipped.noLoc]));
  }
  if (skipped.nonStock.size) console.log(`  skipped, non-stock (Service) items ....... ${skipped.nonStock.size}`);
  if (skipped.zero) console.log(`  skipped, zero on hand (--nonzero-only) ... ${skipped.zero}`);
  if (skipped.merged.length) {
    console.log(`  merged, two live items share one local code .. ${skipped.merged.length}`);
    console.log(listSample(skipped.merged));
  }

  const nonZeroInserts = toInsert.filter((w) => w.qtyBase !== 0).length;
  const negatives = [...wanted.values()].filter((w) => w.qtyBase < 0).length;
  console.log('\nPlan');
  console.log(`  insert new rows ............. ${toInsert.length} (${nonZeroInserts} with stock, ${toInsert.length - nonZeroInserts} at zero)`);
  console.log(`  ${OVERWRITE ? 'overwrite existing rows ....' : 'existing rows left alone ..'} ${OVERWRITE ? toUpdate.length : leftAlone.length}`);
  console.log(`  rows already in agreement ... ${wanted.size - toInsert.length - toUpdate.length - leftAlone.length}`);
  if (negatives) console.log(`  (${negatives} of these carry a negative on-hand in live and are written as-is)`);

  const differing = OVERWRITE ? toUpdate : leftAlone;
  if (differing.length) {
    console.log(`\n  ${OVERWRITE ? 'Overwriting' : 'NOT touching'} these rows -- this build has already written them, and`);
    console.log(`  ${OVERWRITE ? 'the snapshot figure replaces what is there' : 'their movement may post-date the snapshot'}:`);
    const sample = [...differing]
      .sort((a, b) => Math.abs(b.qtyBase - b.current) - Math.abs(a.qtyBase - a.current))
      .slice(0, 12)
      .map((w) => `${w.item.display_name} @ ${w.locName}: ${fmt(w.current)} -> ${fmt(w.qtyBase)}`);
    console.log(listSample(sample, 12));
  }

  if (DRY_RUN) {
    console.log('\nDry run -- nothing written.');
    await pool.end();
    return;
  }
  if (!toInsert.length && !toUpdate.length) {
    console.log('\nNothing to write.');
    await pool.end();
    return;
  }

  const conn = await pool.getConnection();
  let inserted = 0;
  let updated = 0;
  try {
    await conn.beginTransaction();
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const chunk = toInsert.slice(i, i + BATCH).map((w) => [w.invId, w.locId, w.qtyBase, 0, 0]);
      const [res] = await conn.query(
        'INSERT INTO inventory_locations (inventory_id, location_id, qty_on_hand, qty_committed, qty_in_transit) VALUES ?',
        [chunk]
      );
      inserted += res.affectedRows;
    }
    for (let i = 0; i < toUpdate.length; i += BATCH) {
      const chunk = toUpdate.slice(i, i + BATCH).map((w) => [w.invId, w.locId, w.qtyBase]);
      // ON DUPLICATE KEY on uq_inv_loc(inventory_id, location_id): only qty_on_hand is
      // restated, so qty_committed / qty_in_transit survive untouched.
      const [res] = await conn.query(
        `INSERT INTO inventory_locations (inventory_id, location_id, qty_on_hand) VALUES ?
         ON DUPLICATE KEY UPDATE qty_on_hand = VALUES(qty_on_hand)`,
        [chunk]
      );
      updated += chunk.length;
      void res;
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const [[after]] = await pool.query(
    'SELECT COUNT(*) AS rows_ct, SUM(qty_on_hand <> 0) AS with_stock FROM inventory_locations'
  );
  console.log(`\nDone. ${inserted} row(s) inserted, ${updated} updated.`);
  console.log(`inventory_locations now holds ${after.rows_ct} row(s), ${after.with_stock} with stock.`);
  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
