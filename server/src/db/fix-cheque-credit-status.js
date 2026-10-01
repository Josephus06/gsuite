// Undo what the first backfill-bill-credit-status.js run did to cheques it should not have touched.
//
// That run judged a cheque Fully Applied only when its credits' applied amounts reached the
// CHEQUE's total -- but a credit need not equal its cheque (withholding, an advance split over
// several credits), so it moved 360 cheques, some of them away from what the source shows.
// lib/billCreditStatus.js now judges by the credits themselves.
//
// For every cheque a credit was made from, this compares T1S's status with the source's:
//   - none of its credits created in T1S since go-live  -> the source's status is right; restore it
//   - a credit created in T1S since go-live             -> T1S's own rule decides (left as it is)
// Void is never changed. Each UPDATE is guarded on the status read.
//
//   node src/db/fix-cheque-credit-status.js            # dry run
//   node src/db/fix-cheque-credit-status.js --apply
//   --since="2026-10-01 00:00:00"   when T1S credits start (default: go-live morning, DB time)
const pool = require('../db');
require('dotenv').config();
const { chequeStatus } = require('../lib/chequeSource');

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const SINCE = (process.argv.find((a) => a.startsWith('--since=')) || '--since=2026-10-01 00:00:00').split('=')[1];
const PAGE = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));

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
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 90000 + a * 30000);
    try {
      const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload), signal: ctl.signal });
      const j = await r.json(); clearTimeout(timer); return j;
    } catch (e) { clearTimeout(timer); last = e; await sleep(2000 * (a + 1)); }
  }
  throw last;
}

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN'}  T1S credits since ${SINCE}`);
  const [rows] = await pool.query(
    `SELECT c.id, c.cheque_no, c.status,
            SUM(bc.created_at >= ?) AS t1s_credits, COUNT(*) AS credits
       FROM cheques c JOIN bill_credits bc ON bc.cheque_id = c.id
      WHERE c.status <> 'void'
      GROUP BY c.id, c.cheque_no, c.status`, [SINCE]);
  const byNo = new Map(rows.map((r) => [r.cheque_no, r]));
  console.log(`Cheques with credits: ${rows.length}`);

  const token = await login();
  const fixes = []; const tally = { agree: 0, t1sKept: 0, notInSource: 0, toRestore: 0 }; const moves = {};
  const seen = new Set();
  for (let off = 0; off < 100000; off += PAGE) {
    const page = listRows(await api(token, 'get_transactions', { where: { Module_TransH: 'CHEQUE' }, limit: PAGE, offset: off }));
    if (!page.length) break;
    for (const h of page) {
      const c = byNo.get(h.UserPK_TransH);
      if (!c) continue;
      seen.add(c.cheque_no);
      const src = chequeStatus(h.Status_TransH);
      if (src === c.status) { tally.agree += 1; continue; }
      if (Number(c.t1s_credits) > 0) { tally.t1sKept += 1; continue; }
      if (src === 'void') continue; // a void comes from the cheque's own void, not from here
      tally.toRestore += 1;
      const k = `${c.status} -> ${src}`; moves[k] = (moves[k] || 0) + 1;
      fixes.push({ id: c.id, no: c.cheque_no, from: c.status, to: src });
    }
    process.stdout.write(`\r  read ${off + page.length} source cheques`);
    if (page.length < PAGE) break;
  }
  tally.notInSource = rows.length - seen.size;
  console.log('\n', tally, '\nRestores:', moves);
  console.log('Sample:', fixes.slice(0, 12).map((f) => `${f.no} ${f.from}->${f.to}`).join(', '));
  if (!APPLY) return;
  let done = 0;
  for (const f of fixes) {
    const [r] = await pool.query('UPDATE cheques SET status = ? WHERE id = ? AND status = ?', [f.to, f.id, f.from]);
    done += r.affectedRows;
  }
  console.log(`Restored ${done} cheque(s) to the source's status.`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
