// Migrates the item master types that were never brought across.
//
// The Inventory Items page here holds 4,398 rows, but live splits its item master into five
// modules and only some of them were imported. Counting what live has against what we hold:
//
//   INVTY       4,330 live,    35 missing   (inventory items)
//   NONINVTY    2,096 live, 2,096 missing   -- the whole module, never imported
//   LANDEDCOST      6 live,     6 missing   (freight, cutting, packing, custom, trucking)
//   DISCOUNT       12 live,    12 missing
//   SERVICE       100 live,     0 missing   (already complete)
//
// That gap is what made 20,077 purchase order lines fall back to the MISC-PO placeholder:
// the item they name is real, it simply had no row here. PO-17293-1 asks for
// FREIGHT/SHIPPING CHARGES, a LANDEDCOST item; most of the rest are NONINVTY.
//
// All five land in `inventories`, which is how this app already models them -- the Service
// Items page is just /inventory filtered to item_type='Service'. So item_type carries the
// module, and the existing Service page keeps working unchanged.
//
// get_inventories cannot be listed in full (it times out), but filtering by Module_Invty
// pages fine, which is what makes this possible at all.
//
// IDEMPOTENT: an item already present by code is left completely alone -- this never edits
// an existing row, only inserts absent ones.
//
//   node src/db/import-item-masters.js --dry-run
//   node src/db/import-item-masters.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const PAGE = 200;

// Live module -> the item_type this app stores. INVENTORY and Service already exist in the
// data; the other three are new but follow the same convention.
const TYPE_BY_MODULE = {
  INVTY: 'INVENTORY',
  NONINVTY: 'Non-Inventory',
  LANDEDCOST: 'Landed Cost',
  DISCOUNT: 'Discount',
  SERVICE: 'Service',
};

const norm = (s) => (s || '').toString().trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

async function api(token, ep, payload, attempts = 4) {
  let last;
  for (let a = 0; a < attempts; a += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000 + a * 15000);
    try {
      const r = await fetch(`${SITE}/api/${ep}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload), signal: ctl.signal,
      });
      const j = await r.json(); clearTimeout(timer); return j;
    } catch (e) { clearTimeout(timer); last = e; await sleep(1200 * (a + 1)); }
  }
  throw last;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- report only.\n' : 'APPLYING.\n');

  const [existing] = await pool.query('SELECT item_code FROM inventories');
  const have = new Set(existing.map((i) => norm(i.item_code)));
  console.log(`Local inventories: ${have.size} item(s).`);

  const [units] = await pool.query('SELECT id, code, title FROM units_of_measure');
  const unitByCode = new Map();
  for (const u of units) {
    unitByCode.set(norm(u.code), u.id);
    unitByCode.set(norm(u.title), u.id);
  }
  // base_unit_id is NOT NULL, so an item whose unit live does not state still needs one.
  const [[fallbackUnit]] = await pool.query("SELECT id FROM units_of_measure WHERE code = 'PC' LIMIT 1");
  const defaultUnit = fallbackUnit?.id || units[0]?.id;
  if (!defaultUnit) throw new Error('No units_of_measure rows -- cannot create items.');

  const [[cat]] = await pool.query('SELECT id FROM inventory_categories ORDER BY id LIMIT 1');

  const token = await login();
  const summary = [];
  let created = 0;
  const unmatchedUnits = new Set();

  for (const [mod, itemType] of Object.entries(TYPE_BY_MODULE)) {
    // Page to exhaustion; a short page under load is not the end of the module.
    const rows = [];
    let emptyStreak = 0;
    for (let off = 0; off < 40000; off += PAGE) {
      let batch = [];
      try { batch = listRows(await api(token, 'get_inventories', { where: { Module_Invty: mod }, limit: PAGE, offset: off })); }
      catch (e) { console.warn(`  !! ${mod} page ${off} failed: ${e.message}`); }
      if (!batch.length) {
        emptyStreak += 1;
        if (emptyStreak >= 2) break;
        continue;
      }
      emptyStreak = 0;
      rows.push(...batch);
    }

    const missing = rows.filter((r) => r.UserPK_Invty && !have.has(norm(r.UserPK_Invty)));
    summary.push({ mod, live: rows.length, missing: missing.length });
    console.log(`${mod.padEnd(12)} live ${String(rows.length).padStart(5)} | creating ${String(missing.length).padStart(5)} as item_type='${itemType}'`);

    for (const r of missing) {
      const code = String(r.UserPK_Invty).slice(0, 100);
      const name = String(r.DisplayName_Invty || r.UserPK_Invty).slice(0, 255);
      const unitName = r.StockUnit_Invty || r.UnitTitle_Invty || null;
      const unitId = unitName ? (unitByCode.get(norm(unitName)) || null) : null;
      if (unitName && !unitId) unmatchedUnits.add(unitName);

      if (!DRY_RUN) {
        await pool.query(
          `INSERT IGNORE INTO inventories
             (item_code, display_name, sales_description, purchase_description, item_type,
              base_unit_id, category_id, is_active, is_po)
           VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, TRUE)`,
          [code, name,
            r.SalesDescription_Invty || null, r.PurchaseDescription_Invty || null,
            itemType, unitId || defaultUnit, cat?.id || null]
        );
      }
      have.add(norm(code));
      created += 1;
    }
  }

  console.log(`\n${DRY_RUN ? 'Would create' : 'Created'} ${created} item(s).`);
  if (unmatchedUnits.size) {
    console.log(`\n${unmatchedUnits.size} unit name(s) live uses had no units_of_measure match (defaulted to PC):`);
    console.log(`   ${[...unmatchedUnits].slice(0, 15).join(' | ')}`);
  }
  const [[after]] = await pool.query('SELECT COUNT(*) AS n FROM inventories');
  console.log(`\ninventories now holds ${after.n} item(s).`);
  console.log('\nRe-run backfill-po-line-item-location-department.js next -- the lines that fell');
  console.log('back to MISC-PO can now resolve to these.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
