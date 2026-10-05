// READ-ONLY. Checks that every Process Costing bracket carries T1S's +8% on Sub Con (and DL) over
// the source (adjust-process-costing-dl.js, 2026-10-01/02): ours = source x 1.08, rounded to 4dp.
// Brackets are matched like sync-process-costing.js does -- process_code, then qty range.
//
//   node src/db/check-subcon-raise.js [--field=direct_labor]
require('dotenv').config();
const pool = require('../db');
const L = require('./lib/liveWindow');

const FIELD = (process.argv.find((a) => a.startsWith('--field=')) || '--field=sub_con').split('=')[1];
const SRC = { sub_con: 'SubCon_CstngL', direct_labor: 'DL_CstngL' }[FIELD];
if (!SRC) throw new Error('--field must be sub_con or direct_labor');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const near = (a, b) => Math.abs(a - b) < 0.006;

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- checking ${FIELD}`);
  const [procs] = await pool.query('SELECT id, process_code FROM processes');
  const procByCode = new Map(procs.map((p) => [p.process_code, p.id]));
  const [ours] = await pool.query(`SELECT id, process_id, qty_min, qty_max, ${FIELD} AS v FROM process_cost_brackets`);
  const byProc = new Map();
  for (const b of ours) { if (!byProc.has(b.process_id)) byProc.set(b.process_id, []); byProc.get(b.process_id).push(b); }
  const t = await L.login();
  const stubs = [];
  for (let off = 0; ; off += 200) {
    const [batch] = (await L.api(t, 'get_costings', { module: 'Process', limit: 200, offset: off }))?.data || [[]];
    if (!batch?.length) break; stubs.push(...batch); if (batch.length < 200) break;
  }
  const res = { raised: [], same: [], other: [], bothZero: 0, unmatched: 0 };
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < stubs.length) {
      const s = stubs[i++];
      const pid = procByCode.get(s.UserPK_Proc);
      if (!pid) continue;
      const d = await L.api(t, 'get_costing', { pk: s.SysPK_Cstng });
      for (const b of d?.data?.[1] || []) {
        const [a, c] = String(b.Range_CstngL || '').trim().split('-');
        const m = (byProc.get(pid) || []).find((x) => Math.abs(num(x.qty_min) - num(a)) < 0.00005 && Math.abs(num(x.qty_max) - num(c)) < 0.00005);
        if (!m) { res.unmatched += 1; continue; }
        const src = num(b[SRC]); const v = num(m.v);
        const row = `${s.UserPK_Proc} ${a}-${c}: source ${src}, T1S ${v}`;
        if (!src && !v) res.bothZero += 1;
        else if (near(v, Math.round(src * 1.08 * 10000) / 10000)) res.raised.push(row);
        else if (near(v, src)) res.same.push(row);
        else res.other.push(`${row} (x${src ? (v / src).toFixed(4) : '-'})`);
      }
    }
  }));
  console.log(`with a ${FIELD}: +8% ${res.raised.length} | NOT raised (= source) ${res.same.length} | other ${res.other.length}`);
  console.log(`both zero: ${res.bothZero}; source brackets not matched to a T1S bracket: ${res.unmatched}`);
  for (const r of res.same) console.log(`  not raised: ${r}`);
  for (const r of res.other) console.log(`  other: ${r}`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
