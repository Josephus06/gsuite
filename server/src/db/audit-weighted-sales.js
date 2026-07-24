// Audit local vs live weighted sales for the migrated reps, every month of 2026. For each
// sales order it compares status and net (local SUM(sol.net_of_tax) vs live SubTotalVatEx),
// then rolls the drift up per rep per month. Read-only -- explains snapshot drift, writes nothing.
//
//   node src/db/audit-weighted-sales.js
require('dotenv').config();
const pool = require('../db');
const SITE = 'http://gsuite.graphicstar.com.ph';

async function login() { const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) }); return (await r.json())?.data?.token; }
async function api(token, ep, payload, ms = 45000) {
  for (let a = 0; a < 4; a += 1) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    try { const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload), signal: ctl.signal }); clearTimeout(t); return await r.json(); }
    catch (e) { clearTimeout(t); if (a === 3) throw e; await new Promise((r) => setTimeout(r, 1500 * (a + 1))); }
  }
}
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (res?.data || []));
const day = (v) => (v || '').toString().slice(0, 10);
const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
const isCanc = (s) => (s || '').toUpperCase().includes('CANCEL');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const REPS = ['Michelle Riveral', 'Arjie Bayagna', 'Jocel Ann Berina', 'Catherine Jane Langajed'];
const repSet = new Set(REPS.map(norm));

async function main() {
  const token = await login();

  // Live: so_upk -> {status, net, month, rep} for our reps, year 2026.
  const live = new Map();
  for (let off = 0; off < 80000; off += 200) {
    const list = listRows(await api(token, 'get_sales_orders', { searchKey: '', viewAll: true, limit: 200, offset: off }));
    if (!list.length) break;
    for (const so of list) {
      const d = day(so.DateCreated_TransH);
      if (d >= '2026-01-01' && d <= '2026-12-31' && repSet.has(norm(so.Name_Empl))) {
        live.set(so.so_upk, { status: so.Status_TransH, net: Number(so.SubTotalVatEx_TransH) || 0, month: Number(d.slice(5, 7)), rep: norm(so.Name_Empl) });
      }
    }
    if (list.every((so) => day(so.DateCreated_TransH) < '2026-01-01')) break;
    if (list.length < 200) break;
    if (off % 2000 === 0) process.stdout.write(`  paged ${off}...\n`);
  }
  console.log(`Live 2026 SOs for reps: ${live.size}\n`);

  // Local: per SO net + status + rep + month.
  const [rows] = await pool.query(
    `SELECT so.sales_order_no, so.status, MONTH(so.date_created) AS month,
            CONCAT(e.first_name, ' ', e.last_name) AS rep,
            ROUND(COALESCE(SUM(sol.net_of_tax), 0), 2) AS net
       FROM sales_orders so
       JOIN employees e ON e.id = so.sales_rep_id
       LEFT JOIN sales_order_lines sol ON sol.sales_order_id = so.id
      WHERE YEAR(so.date_created) = 2026 AND e.id IN (SELECT id FROM employees WHERE CONCAT(first_name,' ',last_name) IN (?))
      GROUP BY so.id`,
    [REPS]
  );
  const local = new Map(rows.map((r) => [r.sales_order_no, r]));

  // Aggregate per rep per month; collect drift rows.
  const agg = new Map(); // key rep|month -> {localNet, liveNet, drift:[]}
  const key = (rep, m) => `${rep}||${m}`;
  const bump = (rep, m) => { const k = key(rep, m); if (!agg.has(k)) agg.set(k, { localNet: 0, liveNet: 0, drift: [], statusDrift: [], missingLive: [], missingLocal: [] }); return agg.get(k); };

  for (const [no, r] of local) {
    const rep = norm(r.rep); const a = bump(rep, r.month);
    const lv = live.get(no);
    const localCounts = r.status !== 'cancelled';
    if (localCounts) a.localNet += Number(r.net);
    if (!lv) { a.missingLive.push(no); continue; }
    const liveCounts = !isCanc(lv.status);
    if (liveCounts) a.liveNet += lv.net;
    if (localCounts !== liveCounts) a.statusDrift.push(`${no}(local ${r.status}/live ${lv.status})`);
    else if (localCounts && Math.abs(Number(r.net) - lv.net) >= 0.5) a.drift.push({ so: no, local: Number(r.net), live: lv.net, diff: Number((Number(r.net) - lv.net).toFixed(2)) });
  }
  // Live SOs missing locally (by rep/month).
  for (const [no, lv] of live) { if (!local.has(no)) { const a = bump(lv.rep, lv.month); a.missingLocal.push(no); } }

  // Report per rep.
  for (const repName of REPS) {
    const rep = norm(repName);
    console.log(`\n===== ${repName} =====`);
    let repLocal = 0, repLive = 0;
    for (let m = 1; m <= 12; m += 1) {
      const a = agg.get(key(rep, m)); if (!a) continue;
      repLocal += a.localNet; repLive += a.liveNet;
      const d = a.localNet - a.liveNet;
      const flag = Math.abs(d) >= 0.5 || a.statusDrift.length || a.missingLive.length || a.missingLocal.length ? '  <-- DRIFT' : '';
      console.log(`  ${MONTHS[m - 1]}: local ${a.localNet.toFixed(2).padStart(13)} | live ${a.liveNet.toFixed(2).padStart(13)} | diff ${d.toFixed(2).padStart(11)}${flag}`);
      a.drift.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).forEach((x) => console.log(`       net  ${x.so}: local ${x.local} vs live ${x.live}  (diff ${x.diff})`));
      a.statusDrift.forEach((s) => console.log(`       stat ${s}`));
      if (a.missingLive.length) console.log(`       not-in-live: ${a.missingLive.join(', ')}`);
      if (a.missingLocal.length) console.log(`       not-in-local: ${a.missingLocal.join(', ')}`);
    }
    console.log(`  YEAR: local ${repLocal.toFixed(2)} | live ${repLive.toFixed(2)} | diff ${(repLocal - repLive).toFixed(2)}`);
  }
  await pool.end();
}
main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
