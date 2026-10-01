// Read-only: every General Journal in the source (get_transactions Module_TransH='JOURNAL') against
// T1S's journals by number -- missing ones (by year, void at source or not) and amount differences.
// Writes the missing numbers to --out for import-journals.js (which skips existing numbers).
//
//   node src/db/compare-journals.js [--out=/root/match2026/journals-missing.json]
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));

(async () => {
  const l = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  const token = (await l.json())?.data?.token;
  if (!token) throw new Error('Source login failed');
  const src = new Map();
  for (let off = 0; off < 80000; off += 500) {
    let rows;
    for (let a = 0; ; a += 1) {
      try {
        const r = await fetch(`${SITE}/api/get_transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ where: { Module_TransH: 'JOURNAL' }, limit: 500, offset: off, order: [['ID_TransH', 'ASC']] }) });
        rows = listRows(await r.json()); break;
      } catch (e) { if (a >= 3) throw e; await new Promise((res) => setTimeout(res, 3000)); }
    }
    if (!rows.length) break;
    for (const h of rows) if (h.UserPK_TransH) src.set(h.UserPK_TransH, h);
    if (rows.length < 500) break;
  }
  const [mine] = await pool.query('SELECT journal_no, total_debit, status FROM journals');
  const local = new Map(mine.map((j) => [j.journal_no, j]));
  const missing = []; const byYear = {}; let voidMissing = 0; let diff = 0; const diffs = [];
  for (const [no, h] of src) {
    const t = local.get(no);
    const isVoid = /void|cancel/i.test(String(h.Status_TransH || ''));
    if (!t) {
      if (isVoid) { voidMissing += 1; continue; }
      const y = String(h.DateCreated_TransH).slice(0, 4);
      byYear[y] = (byYear[y] || 0) + 1;
      missing.push({ no, date: String(h.DateCreated_TransH).slice(0, 10), amount: num(h.TotalAmount_TransH), status: h.Status_TransH, memo: String(h.Memo_TransH || '').slice(0, 80) });
      continue;
    }
    const amt = num(h.TotalAmount_TransH);
    if (amt && Math.abs(amt - num(t.total_debit)) > 0.01) { diff += 1; if (diffs.length < 10) diffs.push([no, amt, num(t.total_debit)]); }
  }
  const t1sOnly = mine.filter((j) => !src.has(j.journal_no)).length;
  console.log(`source journals: ${src.size} | in T1S: ${mine.length} | missing (not void): ${missing.length} | missing but void at source: ${voidMissing} | amount differences: ${diff} | T1S-only: ${t1sOnly}`);
  console.log('missing by year', JSON.stringify(byYear));
  console.log('missing total', missing.reduce((s, m) => s + m.amount, 0).toFixed(2));
  console.log('examples', JSON.stringify(missing.slice(0, 8)));
  if (diffs.length) console.log('amount diffs', JSON.stringify(diffs));
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(missing));
  await pool.end();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
