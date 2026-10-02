// Inventory items the migration brought in WITHOUT their approvals, so they sit in the "For
// Costing Approval" / "For Accounting Approval" tabs though the source approved them long ago.
//
// inventories.is_costing_approved / is_accounting_approved default to 0. The first item import
// only fetched fully-approved items and set both; a later batch (2,144 items on 2026-08-14) never
// set them, so every one of those (LFP-LAPTOP-SLEEVE..., SIGN-ACRYLIC-TRANSLUCENT-WHITE-4.5MM-5'X6')
// reads pending here while the source shows Costing 1 / Accounting 1.
//
// Reads every item's IsApproveCosting_Invty / IsApproveAccounting_Invty from the source and sets
// the T1S flag where the source has it approved. ONLY EVER APPROVES: an item the source has not
// approved, or one created in T1S and genuinely awaiting approval, is left as it is. Matched by
// item code. Re-runnable.
//
//   node src/db/backfill-item-approvals.js            # dry run
//   node src/db/backfill-item-approvals.js --apply
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const PAGE = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));
const key = (s) => String(s || '').trim().toUpperCase();
const yes = (v) => v === 1 || v === '1' || v === true;

async function login() {
  const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  const b = await r.json();
  if (!b?.data?.token) throw new Error(`Login failed: ${b?.message || 'no token'}`);
  return b.data.token;
}
async function api(token, ep, payload, attempts = 5) {
  let last;
  for (let a = 0; a < attempts; a += 1) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 180000 + a * 60000);
    try {
      const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload), signal: ctl.signal });
      const j = await r.json(); clearTimeout(timer); return j;
    } catch (e) { clearTimeout(timer); last = e; await sleep(3000 * (a + 1)); }
  }
  throw last;
}

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN'}`);
  const [pending] = await pool.query(
    'SELECT id, item_code, is_costing_approved, is_accounting_approved FROM inventories WHERE is_costing_approved = 0 OR is_accounting_approved = 0');
  const byCode = new Map(pending.map((i) => [key(i.item_code), i]));
  console.log(`T1S items missing an approval: ${pending.length}`);

  const token = await login();
  const costing = []; const accounting = []; let read = 0; let matched = 0;
  // Advance by what came back, until a page is empty: the source caps the page below PAGE, and
  // reading a short page as the last one stopped the first run after 50 matches.
  for (let off = 0; off < 200000;) {
    const page = listRows(await api(token, 'get_inventories', { where: { Module_Invty: 'INVTY' }, limit: PAGE, offset: off }));
    if (!page.length) break;
    for (const s of page) {
      read += 1;
      const it = byCode.get(key(s.UserPK_Invty));
      if (!it) continue;
      matched += 1;
      if (!it.is_costing_approved && yes(s.IsApproveCosting_Invty)) costing.push(it);
      if (!it.is_accounting_approved && yes(s.IsApproveAccounting_Invty)) accounting.push(it);
    }
    process.stdout.write(`\r  read ${read} source items`);
    off += page.length;
  }
  console.log(`\nMatched ${matched} of the ${pending.length} by item code.`);
  console.log(`Approved on the source -> to approve here: Costing ${costing.length}, Accounting ${accounting.length}`);
  console.log(`Still pending after this (not approved on the source, or T1S-only): Costing ${pending.filter((i) => !i.is_costing_approved).length - costing.length}, Accounting ${pending.filter((i) => !i.is_accounting_approved).length - accounting.length}`);
  console.log(`e.g. ${costing.slice(0, 5).map((i) => i.item_code).join(' | ')}`);
  if (!APPLY) return;

  const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
  let c = 0; let a = 0;
  for (const ids of chunk(costing.map((i) => i.id), 500)) {
    const [r] = await pool.query('UPDATE inventories SET is_costing_approved = 1 WHERE id IN (?) AND is_costing_approved = 0', [ids]); c += r.affectedRows;
  }
  for (const ids of chunk(accounting.map((i) => i.id), 500)) {
    const [r] = await pool.query('UPDATE inventories SET is_accounting_approved = 1 WHERE id IN (?) AND is_accounting_approved = 0', [ids]); a += r.affectedRows;
  }
  console.log(`Approved: Costing ${c}, Accounting ${a}.`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
