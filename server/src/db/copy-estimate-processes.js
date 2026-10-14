// Give a replicated estimate the processes its source has now. EST-210521 was replicated from
// EST-104541 at 05:52 on 2026-10-14, a minute before EST-104541's processes were back-filled from
// the source (backfill-estimate-lines.js) -- so the copy got its line but none of its 7 processes.
//
// Each target line with NO processes is matched to the source line with the same line number, and
// only when quantity and description agree are the source line's processes copied under it -- the
// same rule backfill-estimate-lines.js uses. Lines that already have processes are never touched,
// so it is safe to re-run. The estimate's totals are refreshed afterwards.
//
//   node src/db/copy-estimate-processes.js EST-104541 EST-210521 [--dry-run]
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const [SRC, DST] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase().replace(/\s+/g, ' '));

(async () => {
  if (!SRC || !DST) throw new Error('Usage: node src/db/copy-estimate-processes.js <source EST-no> <target EST-no> [--dry-run]');
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${DRY ? 'DRY RUN' : 'APPLYING'}`);
  const [[src]] = await pool.query('SELECT id, estimate_no FROM estimates WHERE estimate_no = ?', [SRC]);
  const [[dst]] = await pool.query('SELECT id, estimate_no, status FROM estimates WHERE estimate_no = ?', [DST]);
  if (!src || !dst) throw new Error(`${!src ? SRC : DST} not found.`);

  // The copy takes the same columns the Replicate button copies (routes/estimates.js PROCESS_FIELDS):
  // every column of the row except its own id, its line, and its timestamps.
  const [cols] = await pool.query('SHOW COLUMNS FROM estimate_job_order_processes');
  const fields = cols.map((c) => c.Field).filter((f) => !['id', 'estimate_job_order_id', 'created_at', 'updated_at'].includes(f));

  const [srcLines] = await pool.query('SELECT id, line_no, quantity, description FROM estimate_job_orders WHERE estimate_id = ? ORDER BY line_no', [src.id]);
  const [dstLines] = await pool.query(
    `SELECT j.id, j.line_no, j.quantity, j.description,
            (SELECT COUNT(*) FROM estimate_job_order_processes p WHERE p.estimate_job_order_id = j.id) AS procs
       FROM estimate_job_orders j WHERE j.estimate_id = ? ORDER BY j.line_no`, [dst.id]);
  let copied = 0;
  for (const d of dstLines) {
    if (Number(d.procs) > 0) { console.log(`  line ${d.line_no}: already has ${d.procs} process(es) -- skipped`); continue; }
    const s = srcLines.find((x) => Number(x.line_no) === Number(d.line_no));
    if (!s) { console.log(`  line ${d.line_no}: no line ${d.line_no} on ${SRC} -- skipped`); continue; }
    if (Number(s.quantity) !== Number(d.quantity) || norm(s.description) !== norm(d.description)) {
      console.log(`  line ${d.line_no}: quantity / description differ from ${SRC} line ${s.line_no} -- skipped`);
      continue;
    }
    const [procs] = await pool.query('SELECT * FROM estimate_job_order_processes WHERE estimate_job_order_id = ? ORDER BY line_no', [s.id]);
    if (!procs.length) { console.log(`  line ${d.line_no}: ${SRC} line ${s.line_no} has no processes either -- skipped`); continue; }
    console.log(`  line ${d.line_no}: ${DRY ? 'WOULD copy' : 'copying'} ${procs.length} process(es) from ${SRC} line ${s.line_no}`);
    if (DRY) continue;
    for (const p of procs) {
      await pool.query(
        `INSERT INTO estimate_job_order_processes (estimate_job_order_id, ${fields.join(', ')}) VALUES (?, ${fields.map(() => '?').join(', ')})`,
        [d.id, ...fields.map((f) => p[f])]);
      copied += 1;
    }
  }
  if (copied) {
    const { refreshEstimateTotals } = require('../routes/estimates');
    if (typeof refreshEstimateTotals === 'function') await refreshEstimateTotals(dst.id);
    else console.log('  (open the estimate and save once to refresh its totals)');
  }
  console.log(`${copied} process row(s) ${DRY ? 'would be ' : ''}copied onto ${DST}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
