// Fill in the job lines (with their processes/materials) of estimates whose HEADER came over from
// the source but no lines did -- the estimate shows "No job orders." and 0.00 cost/GP while its
// total is right (EST-102387, asked 2026-10-02). Same insert as a full import
// (lib/liveEstimateSync.js insertEstimateJobs).
//
// An estimate whose lines DID come over but without their processes/materials (EST-90265, asked
// 2026-10-05) gets just those: each T1S line with no process rows is matched to the source line in
// the same position, and only when quantity and description agree are the source's process rows
// written under it (insertJobProcesses). Lines that already have processes are never touched, so it
// is safe to re-run.
//
//   node src/db/backfill-estimate-lines.js EST-102387 [EST-...] [--dry-run]
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { login, apiCall, freshCache, fetchEstimateDetail, insertEstimateJobs, insertJobProcesses } = require('../lib/liveEstimateSync');
const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase().replace(/s+/g, ' '));

const DRY = process.argv.includes('--dry-run');
const numbers = process.argv.slice(2).filter((a) => !a.startsWith('--'));

(async () => {
  if (!numbers.length) throw new Error('Name the estimate(s): EST-102387 ...');
  console.log(`${DRY ? 'DRY RUN -- ' : ''}DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const token = await login();
  const cache = freshCache();
  for (const no of numbers) {
    const [[est]] = await pool.query(
      `SELECT e.id, e.total_amount, (SELECT COUNT(*) FROM estimate_job_orders j WHERE j.estimate_id = e.id) AS lines_now
         FROM estimates e WHERE e.estimate_no = ?`, [no]);
    if (!est) { console.log(`${no}: not in T1S -- use import-estimates-by-number.js`); continue; }
    const r = await apiCall(token, 'get_transactions', { where: { UserPK_TransH: no, Module_TransH: 'ESTIMATES' }, limit: 1 });
    const row = (Array.isArray(r?.data?.[0]) ? r.data[0] : r?.data || [])[0];
    if (!row) { console.log(`${no}: not found in the source`); continue; }
    const t = await fetchEstimateDetail(token, row.SysPK_TransH);
    const jobs = t?.transaction_transactionledgerjobs || [];
    const srcTotal = jobs.reduce((s, j) => s + Number(j.GrossAmount_LdgrJob || 0), 0);
    console.log(`${no}: source has ${jobs.length} job line(s), gross ${srcTotal.toFixed(2)} (T1S header ${Number(est.total_amount).toFixed(2)})`);
    for (const j of jobs) console.log(`   ${j.transactionledgerjob_job?.Name_Job || '?'} | ${String(j.Description_LdgrJob || '').slice(0, 60)} | qty ${j.Qty_LdgrJob} | ${j.GrossAmount_LdgrJob} | ${(j.transactionledgerjob_transactionledgerinvtys || []).length} process line(s)`);
    if (!jobs.length) continue;
    if (!Number(est.lines_now)) {
      if (DRY) continue;
      const n = await insertEstimateJobs(cache, est.id, t);
      console.log(`   wrote ${n} job line(s)`);
      continue;
    }
    // Lines are here: fill the processes of those that have none (no row naming a process or an item).
    const [mine] = await pool.query(
      `SELECT j.id, j.line_no, j.description, j.quantity,
              (SELECT COUNT(*) FROM estimate_job_order_processes x
                WHERE x.estimate_job_order_id = j.id AND (x.process_id IS NOT NULL OR x.item_id IS NOT NULL)) AS procs
         FROM estimate_job_orders j WHERE j.estimate_id = ? ORDER BY j.line_no, j.id`, [est.id]);
    if (mine.length !== jobs.length) console.log(`   T1S has ${mine.length} line(s), the source ${jobs.length} -- matching by position, checked line by line`);
    for (let i = 0; i < mine.length; i++) {
      const m = mine[i]; const j = jobs[i];
      if (Number(m.procs)) { console.log(`   line ${m.line_no}: already has ${m.procs} process row(s), left alone`); continue; }
      if (!j) { console.log(`   line ${m.line_no}: no source line in that position -- skipped`); continue; }
      const sameQty = Math.abs(Number(m.quantity) - Number(j.Qty_LdgrJob || 0)) < 1e-6;
      const sameDesc = norm(m.description) === norm(j.Description_LdgrJob);
      if (!sameQty || !sameDesc) { console.log(`   line ${m.line_no}: source line differs (qty ${j.Qty_LdgrJob} / "${String(j.Description_LdgrJob || '').slice(0, 40)}") -- skipped`); continue; }
      const srcCount = (j.transactionledgerjob_transactionledgerinvtys || []).length;
      if (DRY) { console.log(`   line ${m.line_no}: would write ${srcCount} process row(s)`); continue; }
      // Blank placeholder rows (no process, no item) go first so the line isn't left with them.
      await pool.query('DELETE FROM estimate_job_order_processes WHERE estimate_job_order_id = ? AND process_id IS NULL AND item_id IS NULL', [m.id]);
      const n = await insertJobProcesses(cache, m.id, j);
      console.log(`   line ${m.line_no}: wrote ${n} process row(s)`);
    }
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
