// Take the +8% back off DL and Sub Con for the CNC, DPOD and LFP processes, so they match the
// source again (asked 2026-10-08). adjust-process-costing-dl.js raised both columns on every Process
// Costing bracket by 8% (2026-10-01/02); for these three production lines the source's own figures
// are wanted instead.
//
// Which processes: process NAME starting with one of --prefix (default CNC, DPOD, LFP).
// What changes: a bracket's DL / Sub Con is set to the SOURCE's value -- only where it still holds
// exactly source x 1.08 (the raise). A value someone has edited since is left alone and listed, so
// a deliberate change is never overwritten. Brackets are matched to the source as
// check-subcon-raise.js and sync-process-costing.js do: process_code, then qty range.
// Each change is written to the process's System Info, like the raise was.
//
//   node src/db/restore-process-costing-source.js            # preview
//   node src/db/restore-process-costing-source.js --apply
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const L = require('./lib/liveWindow');

const APPLY = process.argv.includes('--apply');
const PREFIXES = ((process.argv.find((a) => a.startsWith('--prefix=')) || '').split('=')[1] || 'CNC,DPOD,LFP')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const FIELDS = { direct_labor: ['DL', 'DL_CstngL'], sub_con: ['Sub Con', 'SubCon_CstngL'] };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const near = (a, b) => Math.abs(a - b) < 0.006;
const r4 = (n) => Math.round(n * 10000) / 10000;
const display = (v) => (v === null || v === undefined ? null : String(Number(v)));

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'} -- processes starting ${PREFIXES.join(', ')}`);
  const [procs] = await pool.query('SELECT id, process_code, process_name FROM processes');
  const wanted = procs.filter((p) => PREFIXES.some((x) => String(p.process_name || '').trim().toUpperCase().startsWith(x)));
  const procByCode = new Map(wanted.map((p) => [p.process_code, p]));
  const [ours] = await pool.query(
    'SELECT id, process_id, qty_min, qty_max, direct_labor, sub_con FROM process_cost_brackets WHERE process_id IN (?)',
    [wanted.length ? wanted.map((p) => p.id) : [0]]);
  const byProc = new Map();
  for (const b of ours) { if (!byProc.has(b.process_id)) byProc.set(b.process_id, []); byProc.get(b.process_id).push(b); }
  const [[admin]] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' ORDER BY id LIMIT 1");
  console.log(`${wanted.length} matching processes, ${ours.length} brackets`);

  const t = await L.login();
  const stubs = [];
  for (let off = 0; ; off += 200) {
    const [batch] = (await L.api(t, 'get_costings', { module: 'Process', limit: 200, offset: off }))?.data || [[]];
    if (!batch?.length) break; stubs.push(...batch); if (batch.length < 200) break;
  }

  const changes = []; const edited = []; let alreadySource = 0; let unmatched = 0;
  let i = 0;
  const mine = stubs.filter((s) => procByCode.has(s.UserPK_Proc));
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < mine.length) {
      const s = mine[i++];
      const proc = procByCode.get(s.UserPK_Proc);
      const d = await L.api(t, 'get_costing', { pk: s.SysPK_Cstng });
      for (const b of d?.data?.[1] || []) {
        const [a, c] = String(b.Range_CstngL || '').trim().split('-');
        const m = (byProc.get(proc.id) || []).find((x) => Math.abs(num(x.qty_min) - num(a)) < 0.00005 && Math.abs(num(x.qty_max) - num(c)) < 0.00005);
        if (!m) { unmatched += 1; continue; }
        for (const [field, [label, srcKey]] of Object.entries(FIELDS)) {
          const src = num(b[srcKey]); const v = num(m[field]);
          if (near(v, src)) { alreadySource += 1; continue; }
          const row = { bracket: m, proc, field, label, src, v, range: `${display(m.qty_min)}-${display(m.qty_max)}` };
          if (near(v, r4(src * 1.08))) changes.push(row); else edited.push(row);
        }
      }
    }
  }));

  for (const c of changes) {
    console.log(`  ${c.proc.process_name} ${c.range} ${c.label}: ${c.v} -> ${c.src}`);
    if (!APPLY) continue;
    await pool.query(`UPDATE process_cost_brackets SET ${c.field} = ? WHERE id = ?`, [c.src, c.bracket.id]);
    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('ProcessCosting', ?, 'Updated', ?, ?, ?, ?)`,
      [c.proc.id, `${c.range} · ${c.label} (back to source, -8%)`.slice(0, 150), display(c.v), display(c.src), admin.id]);
  }
  for (const e of edited) console.log(`  LEFT (edited since, not source x1.08): ${e.proc.process_name} ${e.range} ${e.label}: T1S ${e.v}, source ${e.src}`);
  console.log(`\n${APPLY ? 'Restored' : 'Would restore'} ${changes.length} value(s) to the source | already = source ${alreadySource} | left (edited) ${edited.length} | source brackets not matched ${unmatched}`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
