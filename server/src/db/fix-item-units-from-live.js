// Re-reads an Inventory item's units from the source and corrects them here: Base / Purchase /
// Stock / Sales Unit, Conversion and TO Type.
//
// Found 2026-10-12 on SIGN-LIGHT-LED-STRIPS-12W-WATERPROOF-WARMWHITE-50M: the source has Unit Title
// ROLL-LMTR-50 with Base LMTR, Purchase ROLL, Stock ROLL, Sales LMTR, Conversion 50, TO Type Count;
// T1S had every one of the four units set to ROLL-LMTR-5 (a unit title, and the wrong one) and no
// TO Type. Each unit is matched to units_of_measure by its exact code or title -- a unit the source
// names that does not exist here is reported and that field left alone, never guessed.
//
// --code=<item code> (repeatable), or --composite for every item whose units hold a unit TITLE
// (a code with a dash, e.g. ROLL-LMTR-5) rather than a plain unit. Dry run unless --apply.
// Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/fix-item-units-from-live.js --code=SIGN-LIGHT-LED-STRIPS-12W-WATERPROOF-WARMWHITE-50M
//   node src/db/fix-item-units-from-live.js --composite --apply
require('dotenv').config();
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const COMPOSITE = process.argv.includes('--composite');
const CODES = process.argv.filter((a) => a.startsWith('--code=')).map((a) => a.slice('--code='.length));
// Who the audit rows name -- audit_logs.set_by_user_id is NOT NULL. User #1, the admin.
const BY = Number((process.argv.find((a) => a.startsWith('--by=')) || '').split('=')[1]) || 1;
const norm = (s) => String(s || '').trim().toLowerCase();

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  const b = await r.json();
  if (!b?.data?.token) throw new Error(`Login failed: ${b?.message || 'no token'}`);
  return b.data.token;
}

// The source item with exactly this code, or null. A filter the source cannot apply comes back as
// unrelated rows, so only an exact code match counts.
async function liveItem(token, code) {
  const r = await fetch(`${SITE}/api/get_inventories`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ where: { UserPK_Invty: code }, limit: 5 }),
  });
  const j = await r.json();
  const rows = Array.isArray(j?.data?.[0]) ? j.data[0] : (Array.isArray(j?.data) ? j.data : []);
  return rows.find((x) => x.UserPK_Invty === code) || null;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(APPLY ? 'APPLYING.\n' : 'DRY RUN -- nothing will be written (pass --apply).\n');
  if (!CODES.length && !COMPOSITE) throw new Error('Name items with --code=<item code>, or pass --composite.');

  const [units] = await pool.query('SELECT id, code, title FROM units_of_measure');
  const unitBy = new Map();
  for (const u of units) { unitBy.set(norm(u.code), u); if (!unitBy.has(norm(u.title))) unitBy.set(norm(u.title), u); }
  const unitCode = new Map(units.map((u) => [u.id, u.code]));

  const cols = 'id, item_code, base_unit_id, purchase_unit_id, stock_unit_id, sales_unit_id, conversion_factor, to_type';
  let items = [];
  if (CODES.length) [items] = await pool.query(`SELECT ${cols} FROM inventories WHERE item_code IN (?)`, [CODES]);
  if (COMPOSITE) {
    const [more] = await pool.query(
      `SELECT ${cols} FROM inventories i WHERE EXISTS (SELECT 1 FROM units_of_measure u
          WHERE u.id IN (i.base_unit_id, i.purchase_unit_id, i.stock_unit_id, i.sales_unit_id) AND u.code LIKE '%-%')`);
    const seen = new Set(items.map((i) => i.id));
    items.push(...more.filter((i) => !seen.has(i.id)));
  }
  for (const c of CODES) if (!items.some((i) => i.item_code === c)) console.log(`!! ${c}: no such item here.`);
  if (!items.length) { await pool.end(); return; }

  const token = await login();
  let changed = 0;
  for (const it of items) {
    const live = await liveItem(token, it.item_code);
    if (!live) { console.log(`-- ${it.item_code}: not found in the source, left alone.`); continue; }
    const set = {};
    const notes = [];
    for (const [col, field] of [['base_unit_id', 'BaseUnit_Invty'], ['purchase_unit_id', 'PurchaseUnit_Invty'],
      ['stock_unit_id', 'StockUnit_Invty'], ['sales_unit_id', 'SalesUnit_Invty']]) {
      const name = live[field];
      if (!name) continue;
      const u = unitBy.get(norm(name));
      if (!u) { notes.push(`${field.replace('_Invty', '')} ${name} does not exist here`); continue; }
      if (u.id !== it[col]) set[col] = u.id;
    }
    const conv = Number(live.Conversion_Invty);
    if (Number.isFinite(conv) && conv > 0 && Math.abs(conv - Number(it.conversion_factor || 0)) > 0.000001) set.conversion_factor = conv;
    if (live.TOType_Invty && live.TOType_Invty !== (it.to_type || '')) set.to_type = live.TOType_Invty;

    const keys = Object.keys(set);
    const show = (col, v) => (col.endsWith('_unit_id') ? unitCode.get(v) || v : v);
    console.log(`${keys.length ? '>>' : 'ok'} ${it.item_code}${keys.length ? '' : ' -- already matches'}`);
    for (const k of keys) console.log(`     ${k}: ${show(k, it[k]) ?? '(blank)'} -> ${show(k, set[k])}`);
    for (const n of notes) console.log(`     !! ${n}; left as is`);
    if (!keys.length) continue;
    changed += 1;
    if (!APPLY) continue;
    await pool.query(`UPDATE inventories SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...keys.map((k) => set[k]), it.id]);
    for (const k of keys) {
      await pool.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('Inventory', ?, 'Updated', ?, ?, ?, ?)`,
        [it.id, k, it[k] == null ? null : String(show(k, it[k])), String(show(k, set[k])), BY]);
    }
  }
  console.log(`\n${APPLY ? 'Corrected' : 'Would correct'} ${changed} of ${items.length} item(s).`);
  await pool.end();
}

main().catch(async (err) => { console.error(err.message || err); await pool.end(); process.exit(1); });
