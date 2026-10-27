// Items whose module in the SOURCE is Service / Non-Inventory / Landed Cost / Discount but whose
// item_type in T1S says otherwise -- so a Service item sits in the Inventory list, is offered on
// Purchase Orders as stock, asks for Costing/Accounting approval, and so on (asked 2026-10-27).
//
// Reads every item of those four source modules (get_inventories by Module_Invty), matches T1S
// items by item code, and reports the ones whose item_type differs. --apply sets item_type to the
// source's -- but not on an item that has stock on hand in T1S: turning stock into a Service item
// would strand that quantity, so those are listed for a person to look at, unless --include-stocked.
//
//   node src/db/check-item-modules.js                      report (default)
//   node src/db/check-item-modules.js --apply --by=1
//   node src/db/check-item-modules.js --apply --by=1 --include-stocked
//
// Run it against ONE box of the droplet/office pair; replication carries it to the other.
require('dotenv').config();
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const INCLUDE_STOCKED = process.argv.includes('--include-stocked');
const BY = Number((process.argv.find((a) => a.startsWith('--by=')) || '').slice(5)) || null;
const PAGE = 200;
const TYPE_BY_MODULE = { SERVICE: 'Service', NONINVTY: 'Non-Inventory', LANDEDCOST: 'Landed Cost', DISCOUNT: 'Discount' };

const norm = (s) => String(s || '').trim().toLowerCase();
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
    try {
      const r = await fetch(`${SITE}/api/${ep}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      return await r.json();
    } catch (e) { last = e; await sleep(1200 * (a + 1)); }
  }
  throw last;
}

// Pages to exhaustion; two empty pages in a row are the end.
async function fetchAll(token, where) {
  const rows = [];
  let empty = 0;
  for (let off = 0; off < 60000; off += PAGE) {
    let batch = [];
    try { batch = listRows(await api(token, 'get_inventories', { where, limit: PAGE, offset: off })); }
    catch (e) { console.warn(`  !! page ${off} failed: ${e.message}`); }
    if (!batch.length) { empty += 1; if (empty >= 2) break; continue; }
    empty = 0;
    rows.push(...batch);
  }
  return rows;
}

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'REPORT ONLY'}`);
  if (APPLY && !BY) throw new Error('--apply needs --by=<your user id>');
  const token = await login();

  const [items] = await pool.query(
    `SELECT i.id, i.item_code, i.display_name, i.item_type,
            COALESCE((SELECT SUM(il.qty_on_hand) FROM inventory_locations il WHERE il.inventory_id = i.id), 0) AS qty
       FROM inventories i`);
  const byCode = new Map(items.map((i) => [norm(i.item_code), i]));

  const wrong = [];
  for (const [mod, type] of Object.entries(TYPE_BY_MODULE)) {
    const src = await fetchAll(token, { Module_Invty: mod });
    let missing = 0;
    let ok = 0;
    for (const s of src) {
      const it = byCode.get(norm(s.UserPK_Invty));
      if (!it) { missing += 1; continue; }
      if (it.item_type === type) { ok += 1; continue; }
      wrong.push({ ...it, expected: type, module: mod });
    }
    console.log(`${mod.padEnd(11)} source ${String(src.length).padStart(5)} | right type ${ok} | WRONG ${src.length - ok - missing} | not in T1S ${missing}`);
  }

  if (!wrong.length) { console.log('\nEvery item matches its source module.'); return; }
  console.log(`\n${wrong.length} item(s) with the wrong type:`);
  for (const w of wrong) {
    console.log(`  ${w.item_code.padEnd(40)} T1S "${w.item_type || '(blank)'}" -> source ${w.expected}${Number(w.qty) ? `   (stock on hand ${Number(w.qty)})` : ''}`);
  }
  if (!APPLY) { console.log('\nREPORT ONLY -- nothing written. Re-run with --apply --by=<your user id>.'); return; }

  let changed = 0;
  let skipped = 0;
  for (const w of wrong) {
    if (Number(w.qty) && !INCLUDE_STOCKED) { skipped += 1; continue; }
    const [r] = await pool.query('UPDATE inventories SET item_type = ? WHERE id = ? AND item_type <=> ?', [w.expected, w.id, w.item_type]);
    changed += r.affectedRows;
  }
  console.log(`\nUpdated ${changed} item(s) (by user ${BY}).${skipped ? ` Left ${skipped} with stock on hand -- check them, then --include-stocked.` : ''}`);
}

main()
  .catch((e) => { console.error('ERR', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
