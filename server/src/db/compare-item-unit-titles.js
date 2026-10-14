// Inventory items whose Unit Title or units disagree with the source (asked 2026-10-14: "check unit
// title of all item inventory, there are some not match to the source").
//
// The item import brought each item's units across (base / purchase / stock / sales unit, conversion
// factor -- import-item-master-details.js) but never its Unit Title: inventories.unit_title_id came
// later (import-unit-of-measures.js, 2026-10-12) and only the dozen items edited since have one.
// This reads every INVTY item from the source and compares, field by field:
//
//   Unit Title        UnitTitle_Invty   -> unit_title_id   (unit_titles, matched by title)
//   Base Unit         BaseUnit_Invty    -> base_unit_id    (units_of_measure, by code or title)
//   Purchase Unit     PurchaseUnit_Invty-> purchase_unit_id
//   Stock Unit        StockUnit_Invty   -> stock_unit_id
//   Sales Unit        SalesUnit_Invty   -> sales_unit_id
//   Conversion Factor Conversion_Invty  -> conversion_factor
//
// Items are matched on the item code (UserPK_Invty = inventories.item_code). Every difference is
// written to a CSV; with --apply each differing field is set to the source's value. A source unit
// or title this app does not have is reported and left alone, never guessed. Where the source's
// title appears more than once in unit_titles (it has duplicates), the one whose units agree with
// the item's source units is used.
//
//   node src/db/compare-item-unit-titles.js                  # report only, writes the CSV
//   node src/db/compare-item-unit-titles.js SIGN-ACRYLIC-... # one item, every field shown
//   node src/db/compare-item-unit-titles.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const ONE = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;
const PAGE = 200;
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase().replace(/\s+/g, ' '));
const numN = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  const b = await r.json();
  if (!b?.data?.token) throw new Error(`Login to the source failed: ${b?.message || 'no token'}`);
  return b.data.token;
}
async function api(token, payload) {
  let last;
  for (let a = 0; a < 4; a += 1) {
    try {
      const r = await fetch(`${SITE}/api/get_inventories`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      return await r.json();
    } catch (e) { last = e; await sleep(1500 * (a + 1)); }
  }
  throw last;
}
// Pages to exhaustion; two empty pages in a row is the end (a short page under load is not).
async function fetchItems(token) {
  const rows = [];
  let empty = 0;
  for (let off = 0; off < 60000; off += PAGE) {
    const where = { Module_Invty: 'INVTY', ...(ONE ? { UserPK_Invty: ONE } : {}) };
    const batch = listRows(await api(token, { where, order: [['ID_Invty', 'ASC']], limit: PAGE, offset: off }));
    if (!batch.length) { empty += 1; if (empty >= 2) break; continue; }
    empty = 0;
    rows.push(...batch);
    if (ONE) break;
  }
  return rows;
}

const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'REPORT ONLY'}`);
  const token = await login();
  const src = await fetchItems(token);
  console.log(`Source: ${src.length} inventory item(s).`);

  const [units] = await pool.query('SELECT id, code, title FROM units_of_measure');
  const unitBy = new Map();
  const unitLabel = new Map();
  for (const u of units) { unitBy.set(norm(u.code), u.id); if (!unitBy.has(norm(u.title))) unitBy.set(norm(u.title), u.id); unitLabel.set(u.id, u.code); }
  const unitId = (name) => (name ? unitBy.get(norm(name)) || null : null);

  const [titles] = await pool.query('SELECT id, title, purchase_unit, stock_unit, base_unit FROM unit_titles');
  const titlesBy = new Map();
  for (const t of titles) { if (!titlesBy.has(norm(t.title))) titlesBy.set(norm(t.title), []); titlesBy.get(norm(t.title)).push(t); }
  const titleLabel = new Map(titles.map((t) => [t.id, t.title]));
  const titleIdFor = (r) => {
    const cands = titlesBy.get(norm(r.UnitTitle_Invty)) || [];
    if (cands.length <= 1) return cands[0]?.id || null;
    const fit = cands.find((t) => norm(t.purchase_unit) === norm(r.PurchaseUnit_Invty) && norm(t.stock_unit) === norm(r.StockUnit_Invty)
      && norm(t.base_unit) === norm(r.BaseUnit_Invty));
    return (fit || cands[0]).id;
  };

  const [locals] = await pool.query(
    `SELECT id, item_code, unit_title_id, base_unit_id, purchase_unit_id, stock_unit_id, sales_unit_id, conversion_factor
       FROM inventories ${ONE ? 'WHERE item_code = ?' : ''}`, ONE ? [ONE] : []);
  const localBy = new Map(locals.map((l) => [norm(l.item_code), l]));

  const FIELDS = [
    { key: 'unit_title_id', label: 'Unit Title', srcVal: (r) => r.UnitTitle_Invty, want: titleIdFor, show: (id) => titleLabel.get(id) || '' },
    { key: 'base_unit_id', label: 'Base Unit', srcVal: (r) => r.BaseUnit_Invty, want: (r) => unitId(r.BaseUnit_Invty), show: (id) => unitLabel.get(id) || '' },
    { key: 'purchase_unit_id', label: 'Purchase Unit', srcVal: (r) => r.PurchaseUnit_Invty, want: (r) => unitId(r.PurchaseUnit_Invty), show: (id) => unitLabel.get(id) || '' },
    { key: 'stock_unit_id', label: 'Stock Unit', srcVal: (r) => r.StockUnit_Invty, want: (r) => unitId(r.StockUnit_Invty), show: (id) => unitLabel.get(id) || '' },
    { key: 'sales_unit_id', label: 'Sales Unit', srcVal: (r) => r.SalesUnit_Invty, want: (r) => unitId(r.SalesUnit_Invty), show: (id) => unitLabel.get(id) || '' },
    { key: 'conversion_factor', label: 'Conversion Factor', srcVal: (r) => r.Conversion_Invty, want: (r) => numN(r.Conversion_Invty), show: (v) => (v == null ? '' : Number(v)) },
  ];

  const diffs = []; // { code, field, t1s, source, note }
  const counts = Object.fromEntries(FIELDS.map((f) => [f.label, 0]));
  const unresolved = new Map(); // source value with no local match -> count
  let notLocal = 0; let itemsChanged = 0;
  for (const r of src) {
    const l = localBy.get(norm(r.UserPK_Invty));
    if (!l) { notLocal += 1; continue; }
    const sets = {};
    for (const f of FIELDS) {
      const raw = f.srcVal(r);
      const want = f.want(r);
      const have = l[f.key];
      const same = f.key === 'conversion_factor'
        ? (want == null || Math.abs(Number(have || 0) - want) < 1e-6)
        : (Number(have || 0) === Number(want || 0));
      if (ONE) console.log(`  ${f.label.padEnd(18)} T1S: ${String(f.show(have) || '(none)').padEnd(28)} source: ${raw ?? '(none)'}${same ? '' : '   <-- differs'}`);
      if (same) continue;
      if (raw && want == null) {
        // The source names something this app does not have: report it, do not blank the field.
        const k = `${f.label}: ${raw}`;
        unresolved.set(k, (unresolved.get(k) || 0) + 1);
        diffs.push({ code: l.item_code, field: f.label, t1s: f.show(have), source: raw, note: 'not found in T1S -- left as is' });
        continue;
      }
      if (!raw && f.key === 'base_unit_id') continue; // base_unit_id is NOT NULL; never blank it
      counts[f.label] += 1;
      diffs.push({ code: l.item_code, field: f.label, t1s: f.show(have), source: raw ?? '', note: '' });
      sets[f.key] = want;
    }
    if (Object.keys(sets).length) {
      itemsChanged += 1;
      if (APPLY) {
        const keys = Object.keys(sets);
        await pool.query(`UPDATE inventories SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`, [...keys.map((k) => sets[k]), l.id]);
      }
    }
  }

  const out = path.join(require('os').tmpdir(), `item-unit-differences-${new Date().toISOString().slice(0, 10)}.csv`);
  fs.writeFileSync(out, ['Item Code,Field,T1S,Source,Note', ...diffs.map((d) => [d.code, d.field, d.t1s, d.source, d.note].map(csvCell).join(','))].join('\n'));

  console.log(`\nItems in the source but not in T1S: ${notLocal}`);
  console.log(`Items that differ: ${itemsChanged} ${APPLY ? '(updated to the source)' : '(would be updated with --apply)'}`);
  for (const [k, n] of Object.entries(counts)) console.log(`  ${k.padEnd(18)} ${n}`);
  if (unresolved.size) {
    console.log(`\nSource values with no match in T1S (left as they are):`);
    [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([k, n]) => console.log(`  ${k}  (${n} item${n === 1 ? '' : 's'})`));
  }
  console.log(`\nEvery difference: ${out}`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
