// Pulls each job type's process list from the live GraphicStar site into job_type_processes.
//
// The live screen is #/job_crud/<SysPK_Job> -> Processes tab; it is served by
//   get_jobs { where: {...}, include: [["job_jobprocesses", "jobprocess_process"]] }
// and the link rows carry only Seq_JProc plus the process FK. There is NO time study on the
// live link (checked: no minute/duration field anywhere in the payload) -- the "Need Time"
// column belongs to the separate PMS app, so job_type_processes.minutes_per_unit is left
// alone here and stays something a person enters on our Job Type screen.
//
// Additive by default: it adds links live has and we lack, and corrects sort_order. Local
// links live does not have are reported but kept, since dropping a process off a job type
// silently changes what future job orders cost. Pass --prune to remove them as well.
//
// get_jobs is NOT just the job-type master: of 1,459 live rows, 1,355 are Module_Job
// "ECommerce" (web-shop products, almost all with a blank UserPK_Job). Only JO and
// Non Standard JO are job types, and several of those share a code -- so live rows are
// resolved and GROUPED by local job type first, and each job type is synced exactly once.
// Syncing per live row instead double-counts every shared code.
//
//   node src/db/import-job-type-processes.js [--dry-run] [--prune] [--job=CNC-LABELS]
const { chromium } = require('playwright');
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph/';
const USERNAME = process.env.LIVE_SITE_USERNAME;
const PASSWORD = process.env.LIVE_SITE_PASSWORD;
const PAGE_SIZE = 50; // the include makes each row heavy -- 200 at a time times out
const JOB_TYPE_MODULES = new Set(['JO', 'Non Standard JO']);

const DRY_RUN = process.argv.includes('--dry-run');
const PRUNE = process.argv.includes('--prune');
const ONLY_JOB = (process.argv.find((a) => a.startsWith('--job=')) || '').split('=')[1] || null;

if (!USERNAME || !PASSWORD) {
  console.error('Set LIVE_SITE_USERNAME and LIVE_SITE_PASSWORD in server/.env before running this script.');
  process.exit(1);
}

async function apiCall(page, endpoint, body) {
  return page.evaluate(async ({ endpoint, body }) => {
    const res = await fetch(`/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    return res.json();
  }, { endpoint, body });
}

async function main() {
  // Local lookups keyed the way the live records identify themselves: a job type by its
  // UserPK_Job (our item_code), a process by its UserPK_Proc (our process_code).
  const [jobTypeRows] = await pool.query('SELECT id, item_code, display_name FROM job_types');
  const jobTypesByCode = new Map();
  for (const r of jobTypeRows) {
    if (r.item_code) jobTypesByCode.set(String(r.item_code).trim().toUpperCase(), r.id);
    // display_name is the fallback: some rows were created without an item_code.
    if (r.display_name && !jobTypesByCode.has(String(r.display_name).trim().toUpperCase())) {
      jobTypesByCode.set(String(r.display_name).trim().toUpperCase(), r.id);
    }
  }
  const [procRows] = await pool.query('SELECT id, process_code FROM processes');
  const processesByCode = new Map(procRows.map((r) => [String(r.process_code).trim().toUpperCase(), r.id]));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const inputs = await page.$$('input');
  await inputs[0].fill(USERNAME);
  await inputs[1].fill(PASSWORD);
  await page.click('button:has-text("Sign In")');
  await page.waitForTimeout(2500);
  if (page.url().includes('login')) { console.error('Login failed.'); process.exit(1); }
  console.log('Logged in.' + (DRY_RUN ? ' DRY RUN -- nothing will be written.' : '') + (PRUNE ? ' PRUNE enabled.' : ''));

  const stats = { jobsSeen: 0, jobsMatched: 0, linksAdded: 0, linksResequenced: 0, linksPruned: 0 };
  const unmatchedJobs = [];
  const unmatchedProcs = new Set();
  const extraLocal = [];

  // Pass 1: read every live job and group its process codes under the local job type it
  // resolves to. Nothing is written yet -- a code shared by several live rows has to be
  // unioned before the diff, or the second row looks like it is missing the first row's work.
  const wanted = new Map(); // job_type_id -> Map(process_id -> seq)
  const skippedModules = new Map();

  let offset = 0;
  for (;;) {
    const where = ONLY_JOB ? { UserPK_Job: ONLY_JOB } : {};
    const resp = await apiCall(page, 'get_jobs', {
      where,
      include: [['job_jobprocesses', 'jobprocess_process']],
      // Paged on the numeric key, not UserPK_Job: 1,387 live rows share a blank code, so
      // ordering by it is not stable across pages and rows get skipped or repeated.
      order: [['ID_Job', 'ASC']],
      limit: PAGE_SIZE,
      offset,
    });
    const batch = (resp && resp.data) || [];
    if (!batch.length) break;

    for (const job of batch) {
      const jobModule = job.Module_Job || '(none)';
      if (!JOB_TYPE_MODULES.has(jobModule)) {
        skippedModules.set(jobModule, (skippedModules.get(jobModule) || 0) + 1);
        continue;
      }
      stats.jobsSeen++;

      const code = String(job.UserPK_Job || '').trim().toUpperCase();
      const jobTypeId = (code && jobTypesByCode.get(code))
        || jobTypesByCode.get(String(job.DisplayName_Job || '').trim().toUpperCase());
      if (!jobTypeId) { unmatchedJobs.push(job.UserPK_Job || job.DisplayName_Job || '(unnamed)'); continue; }
      stats.jobsMatched++;

      if (!wanted.has(jobTypeId)) wanted.set(jobTypeId, new Map());
      const target = wanted.get(jobTypeId);
      for (const link of job.job_jobprocesses || []) {
        const procCode = String((link.jobprocess_process || {}).UserPK_Proc || '').trim().toUpperCase();
        const processId = processesByCode.get(procCode);
        if (!processId) {
          unmatchedProcs.add((link.jobprocess_process || {}).UserPK_Proc || '(no code)');
          continue;
        }
        // Lowest sequence wins when two live rows disagree, so the ordering stays stable.
        const seq = Number(link.Seq_JProc) || 0;
        if (!target.has(processId) || seq < target.get(processId)) target.set(processId, seq);
      }
    }

    console.log(`  offset=${offset}: ${batch.length} rows (job-type rows matched=${stats.jobsMatched})`);
    offset += PAGE_SIZE;
    if (batch.length < PAGE_SIZE) break;
  }

  // Pass 2: one diff per job type.
  for (const [jobTypeId, procSeqs] of wanted) {
    const [existing] = await pool.query(
      'SELECT id, process_id, sort_order FROM job_type_processes WHERE job_type_id = ?', [jobTypeId]
    );
    const existingByProcess = new Map(existing.map((r) => [r.process_id, r]));

    for (const [processId, seq] of procSeqs) {
      const row = existingByProcess.get(processId);
      if (!row) {
        if (!DRY_RUN) {
          await pool.query(
            'INSERT INTO job_type_processes (job_type_id, process_id, sort_order) VALUES (?, ?, ?)',
            [jobTypeId, processId, seq]
          );
        }
        stats.linksAdded++;
      } else if (Number(row.sort_order) !== seq) {
        // Only the ordering is corrected -- minutes_per_unit is ours and is never touched.
        if (!DRY_RUN) await pool.query('UPDATE job_type_processes SET sort_order = ? WHERE id = ?', [seq, row.id]);
        stats.linksResequenced++;
      }
    }

    for (const row of existing) {
      if (procSeqs.has(row.process_id)) continue;
      extraLocal.push(`job_type ${jobTypeId} -> process_id ${row.process_id}`);
      if (PRUNE) {
        if (!DRY_RUN) await pool.query('DELETE FROM job_type_processes WHERE id = ?', [row.id]);
        stats.linksPruned++;
      }
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Live job-type rows    : ${stats.jobsSeen}`);
  console.log(`Matched               : ${stats.jobsMatched} live rows -> ${wanted.size} distinct job types`);
  console.log(`Skipped, wrong module : ${[...skippedModules].map(([m, n]) => m + '=' + n).join(', ') || 'none'}`);
  console.log(`Process links added   : ${stats.linksAdded}`);
  console.log(`Re-sequenced          : ${stats.linksResequenced}`);
  console.log(`Pruned                : ${stats.linksPruned}${PRUNE ? '' : ' (pass --prune to remove the extras below)'}`);
  if (unmatchedJobs.length) {
    console.log(`\nLive jobs with no local job type (${unmatchedJobs.length}): ${unmatchedJobs.slice(0, 20).join(', ')}${unmatchedJobs.length > 20 ? ' ...' : ''}`);
  }
  if (unmatchedProcs.size) {
    console.log(`\nLive processes missing locally (${unmatchedProcs.size}) -- run import-all-processes.js first: ${[...unmatchedProcs].slice(0, 20).join(', ')}${unmatchedProcs.size > 20 ? ' ...' : ''}`);
  }
  if (extraLocal.length) {
    console.log(`\nLocal links live does not have (${extraLocal.length}): ${extraLocal.slice(0, 20).join(', ')}${extraLocal.length > 20 ? ' ...' : ''}`);
  }

  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM job_type_processes');
  console.log(`\njob_type_processes now has ${total} rows.`);
  await browser.close();
  await pool.end();
}

main().catch((err) => { console.error('Import failed:', err); process.exit(1); });
