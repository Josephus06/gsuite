// Fills in the item master fields that import-item-masters.js never brought across.
//
// That script created the Non-Inventory / Service / Landed Cost / Discount rows in `inventories`
// with only a code, a name, the two descriptions and a fallback base unit. Everything else was
// left empty, so the Non-Inventories page had nothing to show but a code and a name -- no Unit
// Title, no Stock / Purchase / Sales Unit, no Is W/ JO, no Is PO, no Expense account. Live shows
// all of them.
//
// Every one of those fields already has a column on `inventories`; none of them was populated.
// This fills them from live:
//
//   UnitTitle/Base/Stock/Purchase/SalesUnit_Invty -> base_/stock_/purchase_/sales_unit_id
//   SysFK_Exp_Invty  -> expense_account_id   (resolved via live's chart of accounts, by code)
//   SysFK_Cat_Invty  -> category_id          (resolved via live's categories, by name)
//   IsWithJO/IsPO/IsTO/IsRequisition/IsJO_Invty -> is_with_jo / is_po / is_to_item /
//                                                  is_office_supply / is_jo
//   MaxLastPurchPrice_Invty, LastPurchaseDate_Invty, Conversion_Invty, TOType_Invty,
//   IsLength/IsWidth_Invty, MaterialCost_Invty, IsActive_Invty
//
// SAFETY. By default only rows that were never enriched are touched -- purchase_unit_id IS NULL
// is the marker, since the original import could not set it. That makes re-running safe and
// stops this from overwriting anything edited in the app afterwards. --force ignores the marker
// and re-reads every row from live.
//
//   node src/db/import-item-master-details.js --dry-run
//   node src/db/import-item-master-details.js
//   node src/db/import-item-master-details.js --module=NONINVTY --force
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const PAGE = 200;

const argVal = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};
const MODULES = argVal('module', 'NONINVTY,SERVICE,LANDEDCOST,DISCOUNT').split(',').map((s) => s.trim());

const norm = (s) => (s || '').toString().trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));
const numN = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const boolN = (v) => (v === 1 || v === '1' || v === true ? 1 : 0);
const dateN = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

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
// empty pages are.
async function fetchAll(token, ep, where) {
  const rows = [];
  let emptyStreak = 0;
  for (let off = 0; off < 60000; off += PAGE) {
    let batch = [];
    try { batch = listRows(await api(token, ep, { ...(where ? { where } : {}), limit: PAGE, offset: off })); }
    catch (e) { console.warn(`  !! ${ep} page ${off} failed: ${e.message}`); }
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
  console.log(`Modules: ${MODULES.join(', ')}`);
  console.log(DRY_RUN ? 'DRY RUN -- report only.' : 'APPLYING.', FORCE ? '(--force: re-reading every row)' : '');
  console.log('');

  const token = await login();

  // --- live lookups -> local ids --------------------------------------------------------
  const coa = await fetchAll(token, 'get_chart_of_accounts');
  const [localCoa] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts');
  const coaByCode = new Map(localCoa.map((a) => [norm(a.account_code), a.id]));
  const coaByName = new Map(localCoa.map((a) => [norm(a.account_name), a.id]));
  const expenseByLivePk = new Map();
  for (const a of coa) {
    const id = coaByCode.get(norm(a.UserPK_COA)) || coaByName.get(norm(a.Title_COA));
    if (id) expenseByLivePk.set(a.SysPK_COA, id);
  }
  console.log(`chart of accounts: live ${coa.length} | resolved to a local account ${expenseByLivePk.size}`);

  const cats = await fetchAll(token, 'get_categories');
  const [localCats] = await pool.query('SELECT id, name FROM inventory_categories');
  const catByName = new Map(localCats.map((c) => [norm(c.name), c.id]));
  const catByLivePk = new Map();
  const newCats = [];
  for (const c of cats) {
    const name = (c.Name_Cat || c.UserPK_Cat || '').trim();
    if (!name) continue;
    let id = catByName.get(norm(name));
    if (!id) { newCats.push(name); }
    if (id) catByLivePk.set(c.SysPK_Cat, id);
  }
  // Categories live names that this app has never seen are created, otherwise every item would
  // land on whatever category the original import defaulted to.
  if (newCats.length && !DRY_RUN) {
    for (const name of [...new Set(newCats)]) {
      const [r] = await pool.query(
        'INSERT INTO inventory_categories (name, is_active) VALUES (?, TRUE)', [name.slice(0, 255)]
      );
      catByName.set(norm(name), r.insertId);
    }
    for (const c of cats) {
      const name = (c.Name_Cat || c.UserPK_Cat || '').trim();
      const id = catByName.get(norm(name));
      if (id) catByLivePk.set(c.SysPK_Cat, id);
    }
  }
  console.log(`categories: live ${cats.length} | new locally ${[...new Set(newCats)].length} | resolved ${catByLivePk.size}`);

  const [units] = await pool.query('SELECT id, code, title FROM units_of_measure');
  const unitBy = new Map();
  const usedCodes = new Set();
  for (const u of units) {
    unitBy.set(norm(u.code), u.id); unitBy.set(norm(u.title), u.id);
    usedCodes.add(norm(u.code));
  }
  const unitId = (name) => (name ? unitBy.get(norm(name)) || null : null);

  // Live uses composite units that carry their conversion in the name -- "ROLL-LINCH-1800",
  // "LENGTH-LMTR-3.04878048780488". They are real units, not noise, so create the ones this app
  // has never seen rather than leaving the item's unit blank. `code` is UNIQUE varchar(20) and
  // several names are longer, so the code is truncated and de-duplicated; `title` keeps the full
  // name and is what the item actually matches on.
  async function ensureUnit(name) {
    if (!name) return null;
    const existing = unitId(name);
    if (existing) return existing;
    if (DRY_RUN) { unitBy.set(norm(name), -1); return -1; }
    let code = String(name).slice(0, 20);
    for (let i = 2; usedCodes.has(norm(code)); i += 1) {
      code = `${String(name).slice(0, 17)}~${i}`.slice(0, 20);
    }
    const [r] = await pool.query(
      'INSERT INTO units_of_measure (code, title, is_active) VALUES (?, ?, TRUE)',
      [code, String(name).slice(0, 100)]
    );
    usedCodes.add(norm(code));
    unitBy.set(norm(code), r.insertId);
    unitBy.set(norm(name), r.insertId);
    return r.insertId;
  }

  // --- the items ------------------------------------------------------------------------
  const unmatchedUnits = new Set();
  let totalUpdated = 0;

  for (const mod of MODULES) {
    const rows = await fetchAll(token, 'get_inventories', { Module_Invty: mod });
    const codes = rows.map((r) => r.UserPK_Invty).filter(Boolean);
    if (!codes.length) { console.log(`\n${mod}: live returned nothing.`); continue; }

    // Which local rows are in scope: this module's items that still look untouched.
    const [locals] = await pool.query(
      `SELECT id, item_code FROM inventories
        WHERE item_code IN (${codes.map(() => '?').join(',')})
          ${FORCE ? '' : 'AND purchase_unit_id IS NULL'}`, codes
    );
    const idByCode = new Map(locals.map((l) => [norm(l.item_code), l.id]));
    console.log(`\n${mod.padEnd(11)} live ${String(rows.length).padStart(5)} | local rows to fill ${idByCode.size}`);

    let updated = 0;
    for (const r of rows) {
      const id = idByCode.get(norm(r.UserPK_Invty));
      if (!id) continue;

      for (const u of [r.UnitTitle_Invty, r.StockUnit_Invty, r.PurchaseUnit_Invty, r.SalesUnit_Invty, r.BaseUnit_Invty]) {
        if (u && !unitId(u)) { unmatchedUnits.add(u); await ensureUnit(u); }
      }

      const vals = {
        sales_description: r.SalesDescription_Invty || null,
        purchase_description: r.PurchaseDescription_Invty || null,
        base_unit_id: unitId(r.BaseUnit_Invty) || unitId(r.UnitTitle_Invty),
        stock_unit_id: unitId(r.StockUnit_Invty),
        purchase_unit_id: unitId(r.PurchaseUnit_Invty),
        sales_unit_id: unitId(r.SalesUnit_Invty),
        category_id: catByLivePk.get(r.SysFK_Cat_Invty) || null,
        expense_account_id: expenseByLivePk.get(r.SysFK_Exp_Invty) || null,
        is_with_jo: boolN(r.IsWithJO_Invty),
        is_po: boolN(r.IsPO_Invty),
        is_to_item: boolN(r.IsTO_Invty),
        is_office_supply: boolN(r.IsRequisition_Invty),
        is_jo: boolN(r.IsJO_Invty),
        is_length_based: boolN(r.IsLength_Invty),
        is_width_based: boolN(r.IsWidth_Invty),
        is_active: boolN(r.IsActive_Invty),
        last_purchase_price: numN(r.MaxLastPurchPrice_Invty),
        last_purchase_date: dateN(r.LastPurchaseDate_Invty),
        conversion_factor: numN(r.Conversion_Invty),
        to_type: r.TOType_Invty || null,
        material_cost: numN(r.MaterialCost_Invty),
      };
      // base_unit_id is NOT NULL -- never blank it out on the way past.
      if (!vals.base_unit_id) delete vals.base_unit_id;

      if (!DRY_RUN) {
        const keys = Object.keys(vals);
        await pool.query(
          `UPDATE inventories SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
          [...keys.map((k) => vals[k]), id]
        );
      }
      updated += 1;
    }
    console.log(`${' '.repeat(11)} ${DRY_RUN ? 'would fill' : 'filled'} ${updated}`);
    totalUpdated += updated;
  }

  if (unmatchedUnits.size) {
    console.log(`
${unmatchedUnits.size} unit name(s) live uses were missing here and have been created:`);

    console.log(`   ${[...unmatchedUnits].slice(0, 20).join(' | ')}`);
  }

  const [[after]] = await pool.query(
    `SELECT COUNT(*) n, SUM(purchase_unit_id IS NOT NULL) pu, SUM(expense_account_id IS NOT NULL) exp
       FROM inventories WHERE item_type = 'Non-Inventory'`
  );
  console.log(`\nNon-Inventory rows: ${after.n} | with a purchase unit ${after.pu} | with an expense account ${after.exp}`);
  console.log(`${DRY_RUN ? 'Would update' : 'Updated'} ${totalUpdated} row(s) in total.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
