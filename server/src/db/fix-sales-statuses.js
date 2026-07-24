// One-off fix: the first sales import hardcoded every SO to 'billed' and left job_orders
// without a production_stage (so they never appear in Production). This re-fetches just the
// live SO list (fast -- no per-SO detail) to read each order's real status, then updates
// the already-imported local sales_orders + their job_orders.
//
// The JO's production_stage is derived from its SO's status (the live per-JO stage isn't
// listable cheaply -- get_job_orders times out), which is enough to land each JO in a
// sensible Production tab.
//
//   node src/db/fix-sales-statuses.js --from=2026-01-01 --to=2026-07-31 --dry-run
//   node src/db/fix-sales-statuses.js --from=2026-01-01 --to=2026-07-31
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
function argVal(name, def) { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; }
const FROM = argVal('from', '2026-01-01');
const TO = argVal('to', '2026-07-31');
const day = (v) => (v || '').toString().slice(0, 10);
const REPS = new Set(['Michelle Riveral', 'Arjie Bayagna', 'Jocel Ann Berina', 'Catherine Jane  Langajed']);

function soStatus(live) {
  const s = (live || '').toUpperCase();
  if (s.includes('CANCEL')) return 'cancelled';
  if (s.includes('BILLED') || s.includes('PAID')) return 'billed';
  if (s.includes('PENDING BILLING') && s.includes('PARTIAL')) return 'pending_billing_partially_delivered';
  if (s.includes('PENDING BILLING')) return 'pending_billing';
  if (s.includes('PARTIALLY DELIVERED')) return 'partially_delivered';
  if (s.includes('PENDING DELIVERY')) return 'pending_delivery';
  if (s.includes('IN-PROCESS') || s.includes('IN PROCESS')) return 'jo_in_process';
  return 'pending_for_jo';
}
function joStageFromSo(localStatus) {
  return {
    pending_for_jo: 'pending_for_scheduling', jo_in_process: 'in_process',
    pending_delivery: 'completed', partially_delivered: 'partially_completed',
    pending_billing: 'completed', pending_billing_partially_delivered: 'partially_completed',
    billed: 'invoiced', cancelled: null,
  }[localStatus] || 'pending_for_scheduling';
}

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  return (await r.json())?.data?.token;
}
async function api(token, ep, payload, ms = 60000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: ctl.signal,
    });
    clearTimeout(t); return await r.json();
  } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
}
const listRows = (res) => (Array.isArray(res.data?.[0]) ? res.data[0] : (res.data || []));

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING.\n');

  const token = await login();
  const statusBySo = new Map();
  let offset = 0;
  while (offset < 60000) {
    const list = listRows(await api(token, 'get_sales_orders', { searchKey: '', viewAll: true, limit: 200, offset }));
    if (!list.length) break;
    for (const so of list) {
      const d = day(so.DateCreated_TransH);
      if (d >= FROM && d <= TO && REPS.has(so.Name_Empl)) statusBySo.set(so.so_upk, so.Status_TransH);
    }
    if (list.every((so) => day(so.DateCreated_TransH) < FROM)) break;
    offset += 200;
  }
  console.log(`Live statuses read for ${statusBySo.size} sales order(s).\n`);

  const dist = {};
  let sosUpdated = 0, josUpdated = 0, missing = 0;
  for (const [soNo, liveStatus] of statusBySo) {
    const local = soStatus(liveStatus);
    const stage = joStageFromSo(local);
    dist[local] = (dist[local] || 0) + 1;
    const [[row]] = await pool.query('SELECT id FROM sales_orders WHERE sales_order_no = ?', [soNo]);
    if (!row) { missing += 1; continue; }
    if (DRY_RUN) { sosUpdated += 1; continue; }
    await pool.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [local, row.id]);
    const [r] = await pool.query('UPDATE job_orders SET production_stage = ?, is_on_hold = 0 WHERE sales_order_id = ?', [stage, row.id]);
    sosUpdated += 1; josUpdated += r.affectedRows;
  }

  console.log('Local SO status distribution:');
  Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([s, c]) => console.log(`  ${s}: ${c}`));
  console.log(`\n${DRY_RUN ? 'Would update' : 'Updated'} ${sosUpdated} sales order(s)` + (DRY_RUN ? '' : ` and ${josUpdated} job order(s)`) +
    (missing ? `; ${missing} live SO(s) not found locally (outside the imported set).` : '.'));
  if (DRY_RUN) console.log('\nDRY RUN -- nothing written.');
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
