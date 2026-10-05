// Backfills Costing > Material Costing from live (#/material-costs).
//
// The item import brought the stock items across, but their costing came over partially or not at
// all: 471 had no Material Cost or Selling Price, and items that had them carried stale Wastage /
// Mark-Up %, DC %s and purchase costs (LFP-STKR-3M-IJ180CV3: live Wastage 20 / Mark-Up 80 / Selling
// 145, local 5 / 125 / 159). Live keeps all of it on the item record, so this copies it:
//
//   MaterialCost_Invty -> material_cost          SellingPrice_Invty     -> selling_price
//   Tolerance_Invty    -> tolerance_pct          BegSellingPrice_Invty  -> beg_selling_price
//   WAPercent_Invty    -> wastage_allowance_pct  DCPercent_Invty        -> disc_ceiling_pct
//   MUPercent_Invty    -> markup_pct             DCSSPercent_Invty      -> disc_supervisor_pct
//   PriceIndicator_Invty -> price_indicator      DCSMPercent_Invty      -> disc_manager_pct
//   MaxLastPurchPrice_Invty -> last_purchase_price  DCGMPercent_Invty    -> disc_gm_pct
//   MaxAveCost_Invty   -> average_cost           LastPurchaseDate_Invty -> last_purchase_date
//
// The amounts (WA / MU / DC Amount, Subtotal, unrounded price) are not stored here -- the screens
// compute them from these, the same way live does.
//
// SAFETY. Only fields that differ are written, so a re-run is a no-op. Items edited in this app
// (updated_at set -- PUT /inventory stamps it, imports do not) are skipped and listed, because live
// may now be the older copy; --force overwrites them too. Matched by item code.
//
//   node src/db/backfill-material-costing.js --dry-run
//   node src/db/backfill-material-costing.js
//   node src/db/backfill-material-costing.js --force
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const PAGE = 200;
// Stock items live in the INVTY module (Type INVENTORY or JIT); the other four modules have no
// Material Costing.
const MODULE = 'INVTY';

const MAP = [
  ['material_cost', 'MaterialCost_Invty'],
  ['tolerance_pct', 'Tolerance_Invty'],
  ['wastage_allowance_pct', 'WAPercent_Invty'],
  ['markup_pct', 'MUPercent_Invty'],
  ['price_indicator', 'PriceIndicator_Invty'],
  ['selling_price', 'SellingPrice_Invty'],
  ['beg_selling_price', 'BegSellingPrice_Invty'],
  ['disc_ceiling_pct', 'DCPercent_Invty'],
  ['disc_supervisor_pct', 'DCSSPercent_Invty'],
  ['disc_manager_pct', 'DCSMPercent_Invty'],
  ['disc_gm_pct', 'DCGMPercent_Invty'],
  ['last_purchase_price', 'MaxLastPurchPrice_Invty'],
  ['average_cost', 'MaxAveCost_Invty'],
];

const norm = (s) => (s || '').toString().trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));
const numN = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const dateN = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? String(v).slice(0, 10) : null);
const same = (a, b) => (a === null || b === null ? a === b : Math.abs(Number(a) - Number(b)) < 0.00005);

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

// Pages to exhaustion: a short page under load is not the end of the list. Two consecutive
// empty pages are. A page that fails outright aborts the run rather than leaving a silent gap.
async function fetchAll(token, ep, where) {
  const rows = [];
  let emptyStreak = 0;
  for (let off = 0; off < 60000; off += PAGE) {
    const batch = listRows(await api(token, ep, { where, limit: PAGE, offset: off }));
    if (!batch.length) {
      emptyStreak += 1;
      if (emptyStreak >= 2) break;
      continue;
    }
    emptyStreak = 0;
    rows.push(...batch);
    process.stdout.write(`\r  fetched ${rows.length}`);
  }
  process.stdout.write('\n');
  return rows;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- report only.' : 'APPLYING.', FORCE ? '(--force: including items edited in this app)' : '');

  const token = await login();
  const live = await fetchAll(token, 'get_inventories', { Module_Invty: MODULE });
  console.log(`live ${MODULE} items: ${live.length}`);

  const [locals] = await pool.query(
    `SELECT id, item_code, updated_at, last_purchase_date, ${MAP.map(([col]) => col).join(', ')} FROM inventories`
  );
  const localByCode = new Map(locals.map((l) => [norm(l.item_code), l]));

  let updated = 0;
  let unchanged = 0;
  const missing = [];
  const skippedEdited = [];
  const fieldCounts = {};

  for (const r of live) {
    const local = localByCode.get(norm(r.UserPK_Invty));
    if (!local) { missing.push(r.UserPK_Invty); continue; }

    const sets = {};
    for (const [col, key] of MAP) {
      const v = numN(r[key]);
      if (v === null && key !== 'MaxLastPurchPrice_Invty' && key !== 'MaxAveCost_Invty') continue;
      if (!same(local[col] === null ? null : Number(local[col]), v)) sets[col] = v;
    }
    const liveDate = dateN(r.LastPurchaseDate_Invty);
    const localDate = local.last_purchase_date ? String(local.last_purchase_date).slice(0, 10) : null;
    if (liveDate && liveDate !== localDate) sets.last_purchase_date = liveDate;

    if (!Object.keys(sets).length) { unchanged += 1; continue; }
    if (local.updated_at && !FORCE) { skippedEdited.push(local.item_code); continue; }

    for (const col of Object.keys(sets)) fieldCounts[col] = (fieldCounts[col] || 0) + 1;
    if (!DRY_RUN) {
      await pool.query(
        `UPDATE inventories SET ${Object.keys(sets).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        [...Object.values(sets), local.id]
      );
    }
    updated += 1;
  }

  console.log(`\n${DRY_RUN ? 'would update' : 'updated'}: ${updated} | already matching: ${unchanged}`);
  console.log('fields changed:', fieldCounts);
  if (skippedEdited.length) {
    console.log(`\nskipped ${skippedEdited.length} item(s) edited in this app (re-run with --force to overwrite):`);
    skippedEdited.slice(0, 50).forEach((c) => console.log(`  ${c}`));
  }
  if (missing.length) {
    console.log(`\n${missing.length} live item(s) have no local row (not created here):`);
    missing.slice(0, 20).forEach((c) => console.log(`  ${c}`));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
