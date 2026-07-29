// Builds a live-item-pk -> local inventory id map, because the live get_inventories endpoint
// is unusable (times out) yet transactions reference items only by that pk. We harvest the map
// from the ledger lines of the already-imported Purchase Orders: each live PO line carries both
// SysFK_Invty_LdgrInvty (the item pk) and SysPK_LdgrInvty (the line pk we stored as
// purchase_order_lines.live_line_pk with its resolved item_id) -- so re-fetching a PO's lines
// lets us tie each item pk to the local item that line already resolved to. Inventory-adjustment
// lines (which have ONLY the item pk) then resolve through this map.
//
// Stores into live_item_pk_map (idempotent). Resumable, low concurrency.
//   node src/db/build-item-pk-map.js --limit=100   (first 100 POs)
//   node src/db/build-item-pk-map.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
function argVal(name, def) { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; }
const LIMIT = argVal('limit', null) ? Number(argVal('limit', null)) : null;
const CONCURRENCY = 3;

const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  return (await r.json())?.data?.token;
}
async function api(token, ep, payload, ms = 60000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: ctl.signal });
    clearTimeout(t); return await r.json();
  } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
}
async function apiRetry(token, ep, payload, attempts = 4) {
  let last; for (let a = 0; a < attempts; a += 1) {
    try { return await api(token, ep, payload, 60000 + a * 20000); }
    catch (e) { last = e; await sleep(1200 * (a + 1)); }
  }
  throw last;
}
async function mapWithConcurrency(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS live_item_pk_map (
      live_item_pk VARCHAR(64) PRIMARY KEY,
      item_id BIGINT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);

  const [pos] = await pool.query('SELECT id, live_pk FROM purchase_orders WHERE live_pk IS NOT NULL');
  const [plines] = await pool.query('SELECT live_line_pk, item_id FROM purchase_order_lines WHERE live_line_pk IS NOT NULL');
  const itemByLineLivePk = new Map(plines.map((l) => [l.live_line_pk, l.item_id]));
  const [[existing]] = await pool.query('SELECT COUNT(*) n FROM live_item_pk_map');
  console.log(`${pos.length} PO(s), ${itemByLineLivePk.size} PO line(s). Map already has ${existing.n} item(s).\n`);

  const token = await login();
  let targets = LIMIT ? pos.slice(0, LIMIT) : pos;

  let done = 0, mapped = 0, failed = 0;
  const seen = new Set();
  await mapWithConcurrency(targets, CONCURRENCY, async (po) => {
    let lines;
    try { lines = listRows(await apiRetry(token, 'get_transaction_ledger_invtys', { where: { SysFK_TransH_LdgrInvty: po.live_pk } })); }
    catch (e) { failed += 1; return; }
    const pairs = [];
    for (const l of lines) {
      const itemPk = l.SysFK_Invty_LdgrInvty;
      const itemId = itemByLineLivePk.get(l.SysPK_LdgrInvty);
      if (itemPk && itemId && !seen.has(itemPk)) { seen.add(itemPk); pairs.push([itemPk, itemId]); }
    }
    if (pairs.length) {
      try {
        await pool.query('INSERT IGNORE INTO live_item_pk_map (live_item_pk, item_id) VALUES ?', [pairs]);
        mapped += pairs.length;
      } catch (e) { /* ignore dup races */ }
    }
    done += 1;
    if (done % 300 === 0) console.log(`  ...${done}/${targets.length} POs | ${mapped} item pks mapped`);
  });

  const [[total]] = await pool.query('SELECT COUNT(*) n FROM live_item_pk_map');
  console.log(`\nDone. ${done} PO(s) scanned, ${mapped} new item pk(s) this run. Map total: ${total.n}. Failures: ${failed}.`);
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
