// Fill in the job lines (with their processes/materials) of estimates whose HEADER came over from
// the source but no lines did -- the estimate shows "No job orders." and 0.00 cost/GP while its
// total is right (EST-102387, asked 2026-10-02). Same insert as a full import
// (lib/liveEstimateSync.js insertEstimateJobs). An estimate that already has any line is left
// alone, so it is safe to re-run.
//
//   node src/db/backfill-estimate-lines.js EST-102387 [EST-...] [--dry-run]
require('dotenv').config();
const pool = require('../db');
const { login, apiCall, freshCache, fetchEstimateDetail, insertEstimateJobs } = require('../lib/liveEstimateSync');

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
    if (Number(est.lines_now)) { console.log(`${no}: already has ${est.lines_now} line(s), left alone`); continue; }
    const r = await apiCall(token, 'get_transactions', { where: { UserPK_TransH: no, Module_TransH: 'ESTIMATES' }, limit: 1 });
    const row = (Array.isArray(r?.data?.[0]) ? r.data[0] : r?.data || [])[0];
    if (!row) { console.log(`${no}: not found in the source`); continue; }
    const t = await fetchEstimateDetail(token, row.SysPK_TransH);
    const jobs = t?.transaction_transactionledgerjobs || [];
    const srcTotal = jobs.reduce((s, j) => s + Number(j.GrossAmount_LdgrJob || 0), 0);
    console.log(`${no}: source has ${jobs.length} job line(s), gross ${srcTotal.toFixed(2)} (T1S header ${Number(est.total_amount).toFixed(2)})`);
    for (const j of jobs) console.log(`   ${j.transactionledgerjob_job?.Name_Job || '?'} | ${String(j.Description_LdgrJob || '').slice(0, 60)} | qty ${j.Qty_LdgrJob} | ${j.GrossAmount_LdgrJob} | ${(j.transactionledgerjob_transactionledgerinvtys || []).length} process line(s)`);
    if (DRY || !jobs.length) continue;
    const n = await insertEstimateJobs(cache, est.id, t);
    console.log(`   wrote ${n} job line(s)`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
