// SUPERSEDED for non_inventories and service_items -- see import-item-master-details.js.
//
// This put Non-Inventory and Service items into the thin four-column lookup tables. That was
// the wrong home: live treats both as full item master records (units, expense account, JO/PO
// flags, last purchase price) and every purchase order, receipt and vendor bill line points at
// `inventories`. They now live in `inventories` under item_type, with their own Master Lists
// pages, and the two lookup tabs have been removed. Only the landed_costs and discount_items
// parts of this script still back a live screen.
//
// Populates the Master Lists > Lookups item tabs, which were all empty:
//
//   non_inventories   <- live Module_Invty='NONINVTY'    (2,096)
//   service_items     <- live Module_Invty='SERVICE'     (100)
//   landed_costs      <- live Module_Invty='LANDEDCOST'  (6)
//   discount_items    <- live Module_Invty='DISCOUNT'    (12)
//
// These are their proper home. A previous pass put them in `inventories` instead, which is
// wrong as a matter of modelling -- this app already gives each its own lookup table and its
// own tab -- and it made them show up in the Inventory Items list and the Stock Ledger's item
// picker, where a discount or a landed cost has no business appearing.
//
// NOTE ON THE inventories ROWS. They are deliberately left in place for now, because
// purchase_order_lines.item_id, purchase_order_receipt_lines.item_id and
// vendor_bill_lines.item_id all point at `inventories` and nothing else -- there is no
// non_inventory_id column to point at instead. Deleting them would send 6,788 purchase lines
// straight back to the MISC-PO placeholder. routes/inventories.js now excludes the four
// non-stock types from the default listing, so they no longer appear where they should not,
// while the lines that reference them keep working. Properly separating them needs the line
// tables to carry an item-kind reference, which is a schema change worth deciding on
// deliberately rather than doing as a side effect of this import.
//
// IDEMPOTENT: matches on the natural key and never edits an existing row.
//
//   node src/db/import-lookup-item-masters.js --dry-run
//   node src/db/import-lookup-item-masters.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const PAGE = 200;

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

async function fetchModule(token, mod) {
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
  return rows;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- report only.\n' : 'APPLYING.\n');

  const token = await login();

  // --- item_code / display_name shaped tables ------------------------------------------
  for (const [mod, table] of [['NONINVTY', 'non_inventories'], ['SERVICE', 'service_items']]) {
    const rows = await fetchModule(token, mod);
    const [existing] = await pool.query(`SELECT item_code FROM ${table}`);
    const have = new Set(existing.map((r) => norm(r.item_code)));
    const missing = rows.filter((r) => r.UserPK_Invty && !have.has(norm(r.UserPK_Invty)));
    console.log(`${table.padEnd(18)} live ${String(rows.length).padStart(5)} | inserting ${missing.length}`);
    if (!DRY_RUN) {
      for (const r of missing) {
        await pool.query(
          `INSERT IGNORE INTO ${table} (item_code, display_name, unit_price, is_active) VALUES (?, ?, ?, TRUE)`,
          [String(r.UserPK_Invty).slice(0, 100), String(r.DisplayName_Invty || r.UserPK_Invty).slice(0, 255), 0]
        );
      }
    }
  }

  // --- landed costs: name + allocation method -------------------------------------------
  {
    const rows = await fetchModule(token, 'LANDEDCOST');
    const [existing] = await pool.query('SELECT name FROM landed_costs');
    const have = new Set(existing.map((r) => norm(r.name)));
    const missing = rows.filter((r) => r.UserPK_Invty && !have.has(norm(r.UserPK_Invty)));
    console.log(`${'landed_costs'.padEnd(18)} live ${String(rows.length).padStart(5)} | inserting ${missing.length}`);
    if (!DRY_RUN) {
      for (const r of missing) {
        // Live does not state an allocation method on the item; the app's own default applies.
        await pool.query(
          'INSERT IGNORE INTO landed_costs (name, allocation_method, is_active) VALUES (?, ?, TRUE)',
          [String(r.DisplayName_Invty || r.UserPK_Invty).slice(0, 255), 'Value']
        );
      }
    }
  }

  // --- discounts: name + type + value ---------------------------------------------------
  {
    const rows = await fetchModule(token, 'DISCOUNT');
    const [existing] = await pool.query('SELECT name FROM discount_items');
    const have = new Set(existing.map((r) => norm(r.name)));
    const missing = rows.filter((r) => r.UserPK_Invty && !have.has(norm(r.UserPK_Invty)));
    console.log(`${'discount_items'.padEnd(18)} live ${String(rows.length).padStart(5)} | inserting ${missing.length}`);
    if (!DRY_RUN) {
      for (const r of missing) {
        // Live carries no percentage/amount on the item record, so the value stays 0 for
        // someone to set rather than being invented here.
        await pool.query(
          'INSERT IGNORE INTO discount_items (name, discount_type, value, is_active) VALUES (?, ?, ?, TRUE)',
          [String(r.DisplayName_Invty || r.UserPK_Invty).slice(0, 255), 'Amount', 0]
        );
      }
    }
  }

  for (const t of ['non_inventories', 'service_items', 'landed_costs', 'discount_items']) {
    const [[n]] = await pool.query(`SELECT COUNT(*) AS n FROM ${t}`);
    console.log(`${t.padEnd(18)} now holds ${n.n}`);
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
