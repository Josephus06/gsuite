// Imports the live Stock Ledger (Inventory > Inventory Reports > Stock Ledger) verbatim via
// generate_stock_ledger_v2, so the local report matches live exactly -- including Beginning
// balances, which can't be derived from the migrated transactions alone. Stored per item +
// location into live_stock_ledger, resolved to local inventory/location ids where possible.
//
// Live call (positional body): generate_stock_ledger_v2 [cfg, [], [], {limit,offset}]
//   cfg = {filter:'period from', date1:{date:'<from ISO>'}, date2:{date:'<to>'}}
//   response.data = [ totalItemCount, rows[], grandTotalValue ]
//   rows are an item-header row (Colored:1, no Location) followed by its per-location rows
//   ({Location, LocationPK, Input, Output, InputValue, OutputValue, Beg*, Ending*}).
//
//   node src/db/import-stock-ledger.js --from=2026-01-01 --to=2026-07-28
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
function argVal(name, def) { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; }
const FROM = argVal('from', '2026-01-01');
const TO = argVal('to', '2026-07-28');
const PAGE = 100; // items per page

const numN = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const clean = (v) => (v == null ? null : String(v).trim() || null);
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase());
const normWs = (s) => norm(s).replace(/[\s-]+/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  return (await r.json())?.data?.token;
}
async function api(token, ep, body, ms = 120000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: ctl.signal });
    clearTimeout(t); return await r.json();
  } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
}
async function apiRetry(token, ep, body, attempts = 4) {
  let last; for (let a = 0; a < attempts; a += 1) {
    try { return await api(token, ep, body, 120000 + a * 30000); }
    catch (e) { last = e; await sleep(1500 * (a + 1)); }
  }
  throw last;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Stock Ledger import | window ${FROM}..${TO}\n`);

  await pool.query(`CREATE TABLE IF NOT EXISTS live_stock_ledger (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      item_pk VARCHAR(64), item_code VARCHAR(191), inventory_id BIGINT NULL, unit_title VARCHAR(60),
      location_pk VARCHAR(64), location VARCHAR(191), location_id BIGINT NULL,
      beg_qty DECIMAL(24,6), beg_cost DECIMAL(24,6), beg_value DECIMAL(24,4),
      input DECIMAL(24,6), input_value DECIMAL(24,4), output DECIMAL(24,6), output_value DECIMAL(24,4),
      ending_qty DECIMAL(24,6), ending_cost DECIMAL(24,6), ending_value DECIMAL(24,4),
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_item_loc (item_pk, location_pk))`);
  await pool.query('DELETE FROM live_stock_ledger'); // full refresh

  const [invs] = await pool.query('SELECT id, item_code FROM inventories');
  const invByCode = new Map(); for (const it of invs) { const c = norm(it.item_code); if (c && !invByCode.has(c)) invByCode.set(c, it.id); }
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [normWs(l.location_name), l.id]));

  const token = await login();
  // Live sends Date From as PH-midnight expressed in UTC (2026-01-01 PH -> 2025-12-31T16:00:00Z)
  // and Date To as a "Mon DD, YYYY" string.
  const date1ISO = new Date(`${FROM}T00:00:00+08:00`).toISOString();
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [ty, tm, td] = TO.split('-').map(Number);
  const date2Str = `${MONTHS[tm - 1]} ${td}, ${ty}`;
  const cfg = { filter: 'period from', date1: { hide: false, label: 'Date From', date: date1ISO }, date2: { hide: false, label: 'Date To', date: date2Str } };
  console.log(`Live cfg: from ${date1ISO} to "${date2Str}"`);

  let offset = 0, total = null, imported = 0, unresolvedItem = 0, unresolvedLoc = 0;
  while (true) {
    let resp;
    try { resp = await apiRetry(token, 'generate_stock_ledger_v2', [cfg, [], [], { limit: PAGE, offset }]); }
    catch (e) { console.error(`  page offset ${offset} failed: ${e.message}`); break; }
    const data = resp?.data;
    if (!Array.isArray(data)) break;
    if (total === null) total = data[0];
    const rows = Array.isArray(data[1]) ? data[1] : [];
    const locRows = rows.filter((r) => r.Location);
    if (!locRows.length) break;

    const values = [];
    for (const r of locRows) {
      const invId = invByCode.get(norm(r.ItemCode)) || null; if (!invId) unresolvedItem += 1;
      const locId = locByName.get(normWs(r.Location)) || null; if (!locId) unresolvedLoc += 1;
      values.push([
        r.ItemPK, clean(r.ItemCode), invId, clean(r.UnitTitle), r.LocationPK, clean(r.Location), locId,
        numN(r.BegQty), numN(r.BegCost), numN(r.Begvalue),
        numN(r.Input), numN(r.InputValue), numN(r.Output), numN(r.OutputValue),
        numN(r.EndingQty), numN(r.EndingCost), numN(r.Endingvalue),
      ]);
    }
    if (values.length) {
      await pool.query(
        `INSERT INTO live_stock_ledger
           (item_pk, item_code, inventory_id, unit_title, location_pk, location, location_id,
            beg_qty, beg_cost, beg_value, input, input_value, output, output_value,
            ending_qty, ending_cost, ending_value)
         VALUES ? ON DUPLICATE KEY UPDATE
           inventory_id=VALUES(inventory_id), location_id=VALUES(location_id),
           beg_qty=VALUES(beg_qty), beg_cost=VALUES(beg_cost), beg_value=VALUES(beg_value),
           input=VALUES(input), input_value=VALUES(input_value), output=VALUES(output), output_value=VALUES(output_value),
           ending_qty=VALUES(ending_qty), ending_cost=VALUES(ending_cost), ending_value=VALUES(ending_value)`,
        [values]);
      imported += values.length;
    }
    offset += PAGE;
    console.log(`  ...offset ${offset}/${total} items | ${imported} ledger rows`);
    if (total != null && offset >= total) break;
  }

  const [[cnt]] = await pool.query('SELECT COUNT(*) n FROM live_stock_ledger');
  console.log(`\nDone. ${cnt.n} stock-ledger row(s). Unresolved: ${unresolvedItem} item(s), ${unresolvedLoc} location(s) (kept with raw code/name).`);
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
