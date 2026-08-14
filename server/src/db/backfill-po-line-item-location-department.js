// Repairs three fields on purchase order lines that the original import left wrong or empty:
//
//   item_id       -- 20,077 of 35,745 lines (56%) fell back to the MISC-PO placeholder
//                    ("Non-inventory / service PO line") instead of the real item. PO-13164
//                    shows MISC-PO where live shows BUILDING INSURANCE.
//   location_id   -- null on 35,729 lines (99.95%). Live has Branch - Ayala.
//   department_id -- null on 35,730 lines (99.96%). Live has Branch - Ayala.
//
// get_transaction_ledger_invtys accepts includes that join the item, location and department
// straight onto each line -- the same trick import-inventory-adjustments.js relies on, and
// far better than resolving item pks one at a time. It gives the real item CODE, and the
// location and department by NAME, in a single call per purchase order.
//
// One call per PO: passing an array of parent pks returns nothing, so batching is not
// available. 19,475 calls, run a few at a time.
//
// Lines are matched on purchase_order_lines.live_line_pk, which the import stored, so nothing
// depends on the two databases agreeing about ids or on line ordering.
//
// An item code with no local inventories row keeps whatever the line already had rather than
// being nulled -- a wrong-but-present item is less damaging than an empty required column,
// and the count is reported.
//
// RESUMABLE: only touches lines still missing a value (or still on MISC-PO).
//
//   node src/db/backfill-po-line-item-location-department.js --dry-run
//   node src/db/backfill-po-line-item-location-department.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY = 4;

const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
// Live and this database punctuate the same department differently -- "Production-LFP" here
// is "Production - LFP" there, and "Production-CNC" is "Production -  CNC" with two spaces.
// Comparing letters and digits only matches those without inventing looser rules like prefix
// matching, which would happily confuse "Support" with "Support - IT".
const squash = (s) => (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
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

async function mapWithConcurrency(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i; i += 1; await fn(items[idx], idx); }
  }));
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- report only.\n' : 'APPLYING.\n');

  const [items] = await pool.query('SELECT id, item_code FROM inventories');
  const itemByCode = new Map(items.map((i) => [norm(i.item_code), i.id]));
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [norm(l.location_name), l.id]));
  const locBySquash = new Map(locs.map((l) => [squash(l.location_name), l.id]));
  const [deps] = await pool.query('SELECT id, name FROM departments');
  const depByName = new Map(deps.map((d) => [norm(d.name), d.id]));
  const depBySquash = new Map(deps.map((d) => [squash(d.name), d.id]));
  const [[misc]] = await pool.query("SELECT id FROM inventories WHERE item_code = 'MISC-PO' LIMIT 1");
  const miscId = misc?.id || null;

  const [lineRows] = await pool.query(
    'SELECT live_line_pk, id, item_id, location_id, department_id FROM purchase_order_lines WHERE live_line_pk IS NOT NULL'
  );
  const lineByPk = new Map(lineRows.map((r) => [r.live_line_pk, r]));

  const [pos] = await pool.query('SELECT id, po_no, live_pk FROM purchase_orders WHERE live_pk IS NOT NULL');
  console.log(`${pos.length} purchase order(s) to walk, ${lineByPk.size} line(s) with a live key.`);
  console.log(`${itemByCode.size} item(s), ${locByName.size} location(s), ${depByName.size} department(s) to match against.\n`);

  const token = await login();

  let done = 0, itemSet = 0, locSet = 0, depSet = 0, noLine = 0, failed = 0;
  const missingItems = new Set();
  const missingLocs = new Set();
  const missingDeps = new Set();

  await mapWithConcurrency(pos, CONCURRENCY, async (po) => {
    let rows;
    try {
      rows = listRows(await api(token, 'get_transaction_ledger_invtys', {
        where: { SysFK_TransH_LdgrInvty: po.live_pk },
        include: ['transactionledgerinvty_invty', 'transactionledgerinvty_location', 'transactionledgerinvty_department'],
        limit: 200, offset: 0,
      }));
    } catch (e) {
      failed += 1;
      done += 1;
      return;
    }

    for (const l of rows) {
      const local = lineByPk.get(l.SysPK_LdgrInvty);
      if (!local) { noLine += 1; continue; }

      const code = l.transactionledgerinvty_invty?.UserPK_Invty || null;
      const locName = l.transactionledgerinvty_location?.Name_Loc || null;
      const depName = l.transactionledgerinvty_department?.Name_Dept || null;

      const itemId = code ? (itemByCode.get(norm(code)) || null) : null;
      if (code && !itemId) missingItems.add(code);
      const locId = locName ? (locByName.get(norm(locName)) || locBySquash.get(squash(locName)) || null) : null;
      if (locName && !locId) missingLocs.add(locName);
      const depId = depName ? (depByName.get(norm(depName)) || depBySquash.get(squash(depName)) || null) : null;
      if (depName && !depId) missingDeps.add(depName);

      const sets = [];
      const params = [];
      // Only replace the item when we resolved a real one AND the line is still the
      // placeholder (or empty) -- never overwrite an item that already resolved properly.
      if (itemId && (local.item_id === null || local.item_id === miscId)) { sets.push('item_id = ?'); params.push(itemId); }
      if (locId && local.location_id === null) { sets.push('location_id = ?'); params.push(locId); }
      if (depId && local.department_id === null) { sets.push('department_id = ?'); params.push(depId); }
      if (!sets.length) continue;

      if (!DRY_RUN) {
        await pool.query(`UPDATE purchase_order_lines SET ${sets.join(', ')} WHERE id = ?`, [...params, local.id]);
      }
      if (sets.some((s) => s.startsWith('item_id'))) itemSet += 1;
      if (sets.some((s) => s.startsWith('location_id'))) locSet += 1;
      if (sets.some((s) => s.startsWith('department_id'))) depSet += 1;
    }

    done += 1;
    if (done % 1000 === 0) {
      console.log(`  ...${done}/${pos.length} PO(s) | item +${itemSet}, location +${locSet}, department +${depSet}`);
    }
  });

  console.log(`\nDone. Walked ${done} purchase order(s), ${failed} failed to fetch.`);
  console.log(`Item set on ${itemSet} line(s), location on ${locSet}, department on ${depSet}.`);
  if (noLine) console.log(`${noLine} live line(s) had no matching local row.`);
  if (missingItems.size) {
    console.log(`\n${missingItems.size} item code(s) live uses have no local inventories row (those lines keep what they had):`);
    console.log(`   ${[...missingItems].slice(0, 15).join(' | ')}`);
  }
  if (missingLocs.size) console.log(`\nUnmatched location name(s): ${[...missingLocs].slice(0, 10).join(' | ')}`);
  if (missingDeps.size) console.log(`Unmatched department name(s): ${[...missingDeps].slice(0, 10).join(' | ')}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
