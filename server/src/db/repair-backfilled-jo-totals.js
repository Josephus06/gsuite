// Repair job_order_processes.total on migrated Job Orders (found 2026-10-03 on JO-72572-1-1).
//
// `total` is a QUANTITY -- how much of the line's item the job uses, in the item's unit (the source
// JO screen's SubTotal / Total: 1, 10, 6.6667). import-jo-processes.js filled it from the source's
// TotalAmountOut_LdgrInvty, which is the line's AMOUNT in pesos (150, 1,630, 1,006.67). The quantity
// is QtyOutTemp_LdgrInvty. With money in `total`, completion %, back orders and what an Assembly
// Build draws from stock (total / job qty x qty built) were all wrong.
//
// For each open JO (not completed / invoiced) this reads the JO from the source the way the
// importer did (get_job_order, lines in the order returned = line_no 1..n), checks the line count
// and every line's process name agree, then sets total = QtyOutTemp and scales total_completed by
// the same factor -- each line keeps the completion % T1S shows. A JO that does not line up is
// skipped and listed. A rollback file of every old value is written before anything changes.
//
//   node src/db/repair-backfilled-jo-totals.js --limit=30          # preview a sample
//   node src/db/repair-backfilled-jo-totals.js                     # preview all open JOs
//   node src/db/repair-backfilled-jo-totals.js --apply             # write
//   node src/db/repair-backfilled-jo-totals.js --rollback=<file>
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');
const L = require('./lib/liveWindow');

const APPLY = process.argv.includes('--apply');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const ROLLBACK = (process.argv.find((a) => a.startsWith('--rollback=')) || '').split('=')[1];
// --only=<file>: just the JO numbers listed in it (text before the first ':' on each line, as in a
// -skipped.txt this script wrote).
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const OPEN = ['pending_for_scheduling', 'in_process', 'in_process_with_revision', 'for_qi', 'partially_completed', 'for_revision'];
// The DPOD ink-coverage processes are named differently in the two systems for the same thing:
// "DPOD - Printing Liquid - A3 - Ink Cov (1-5%)" here, "... - Sht - Ink Coverage - 1-5%" in the
// source. Both normalise to "dpod - printing liquid - ink 1-5".
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
  .replace(/- a3 - ink cov \((\d+-\d+)%\)/, '- ink $1').replace(/- sht - ink coverage - (\d+-\d+)%/, '- ink $1');
const n4 = (v) => Number(Number(v || 0).toFixed(4));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sourceLines(token, joNo) {
  const h = L.listRows(await L.api(token, 'get_transactions', { where: { UserPK_TransH: joNo }, limit: 1 }))[0];
  if (!h) return null;
  for (let a = 0; a < 4; a += 1) {
    const d = await L.api(token, 'get_job_order', { pk: h.SysPK_TransH });
    if (Array.isArray(d?.data) && d.data[0] && Object.keys(d.data[0]).length >= 5) return Array.isArray(d.data[2]) ? d.data[2] : [];
    await sleep(1200 * (a + 1));
  }
  return null;
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${ROLLBACK ? 'ROLLBACK' : APPLY ? 'APPLYING' : 'PREVIEW'}`);
  if (ROLLBACK) {
    const rows = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    for (const r of rows) await pool.query('UPDATE job_order_processes SET total = ?, total_completed = ? WHERE id = ?', [r.old_total, r.old_completed, r.id]);
    console.log(`Restored ${rows.length} line(s).`); await pool.end(); return;
  }
  const [jos] = await pool.query(
    `SELECT DISTINCT jo.id, jo.job_order_no FROM job_orders jo JOIN job_order_processes jop ON jop.job_order_id = jo.id
      WHERE jo.production_stage IN (?) AND jo.nsso_id IS NULL AND jo.parent_job_order_id IS NULL AND jop.total > 0
        ${ONLY ? 'AND jo.job_order_no IN (?)' : ''}
      ORDER BY jo.id ${LIMIT ? 'LIMIT ' + LIMIT : ''}`,
    ONLY ? [OPEN, fs.readFileSync(ONLY, 'utf8').split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean)] : [OPEN]);
  console.log(`Open JOs to check: ${jos.length}`);
  let token = await L.login();
  const fix = []; const skipped = []; let same = 0; let done = 0;
  for (const jo of jos) {
    if ((done += 1) % 300 === 0) { token = await L.login(); console.log(`  ...${done}/${jos.length}`); }
    let src;
    try { src = await sourceLines(token, jo.job_order_no); } catch (e) { skipped.push(`${jo.job_order_no}: ${e.message}`); continue; }
    await sleep(200);
    if (!src) { skipped.push(`${jo.job_order_no}: not in the source`); continue; }
    const [mine] = await pool.query(
      `SELECT jop.id, jop.line_no, jop.total, jop.total_completed, p.process_name
         FROM job_order_processes jop LEFT JOIN processes p ON p.id = jop.process_id
        WHERE jop.job_order_id = ? ORDER BY jop.line_no`, [jo.id]);
    if (mine.length !== src.length) { skipped.push(`${jo.job_order_no}: ${mine.length} lines here, ${src.length} in the source`); continue; }
    const off = mine.findIndex((m, i) => m.process_name && norm(m.process_name) !== norm(src[i].Name_Proc));
    if (off >= 0) { skipped.push(`${jo.job_order_no}: line ${off + 1} is "${mine[off].process_name}" here, "${src[off].Name_Proc}" in the source`); continue; }
    let changed = false;
    mine.forEach((m, i) => {
      const q = src[i].QtyOutTemp_LdgrInvty;
      if (q === null || q === undefined || q === '') return;
      const nt = n4(q); const ot = Number(m.total || 0);
      if (Math.abs(nt - ot) <= 0.0001) return;
      const oc = Number(m.total_completed || 0);
      const nc = ot > 0 ? Math.min(n4(oc * (nt / ot)), nt) : 0;
      fix.push({ id: m.id, jo: jo.job_order_no, line: m.line_no, old_total: ot, new_total: nt, old_completed: oc, new_completed: nc });
      changed = true;
    });
    if (!changed) same += 1;
  }
  console.log(`\nLines to fix: ${fix.length} on ${new Set(fix.map((f) => f.jo)).size} JO(s). Already right: ${same} JO(s). Skipped: ${skipped.length}.`);
  for (const f of fix.slice(0, 25)) console.log(`  ${f.jo} line ${f.line}: total ${f.old_total} -> ${f.new_total}; completed ${f.old_completed} -> ${f.new_completed}`);
  for (const s of skipped.slice(0, 25)) console.log(`  SKIP ${s}`);
  if (!APPLY || !fix.length) { await pool.end(); return; }
  const file = `/root/jo-process-totals-before-repair-${Date.now()}.json`;
  fs.writeFileSync(file, JSON.stringify(fix));
  fs.writeFileSync(file.replace('.json', '-skipped.txt'), skipped.join('\n'));
  console.log(`Rollback file: ${file}`);
  for (let i = 0; i < fix.length; i += 500) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const f of fix.slice(i, i + 500)) await conn.query('UPDATE job_order_processes SET total = ?, total_completed = ? WHERE id = ?', [f.new_total, f.new_completed, f.id]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  console.log(`Repaired ${fix.length} line(s).`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
