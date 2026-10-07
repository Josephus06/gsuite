// Restates estimates' header totals from their job lines -- the same calculation routes/estimates.js
// now runs after every edit (refreshEstimateTotals) -- for the ones whose header went stale before
// that existed, so the Saved Estimates list shows what the estimate's own page shows. EST-206902
// listed 1,142,400 against 571,200 on its page: a Replicate whose lines were changed afterwards.
//
// WHICH ESTIMATES. Every estimate made IN THIS APP -- new or replicated -- whose header disagrees
// with its lines. "Made in this app" is an estimate with a 'Created' row in its audit log, which
// POST /estimates and Replicate both write and the importers never do. Imported estimates are left
// alone: their header is the source's own figure, and on dozens of them the lines are duplicated,
// so restating those from their lines would double approved estimates (see effectiveTotal in
// routes/estimates.js). --only names specific estimates instead, imported or not.
//
//   node src/db/restate-estimate-totals.js --dry-run
//   node src/db/restate-estimate-totals.js
//   node src/db/restate-estimate-totals.js --only=EST-206902 [--dry-run]
const pool = require('../db');
const { refreshEstimateTotals } = require('../routes/estimates');

const DRY_RUN = process.argv.includes('--dry-run');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').map((s) => s.trim()).filter(Boolean);

(async () => {
  try {
    console.log(`Local DB: ${process.env.DB_NAME || ''} on ${process.env.DB_HOST || ''}${DRY_RUN ? ' -- DRY RUN, nothing written' : ''}`);
    const [rows] = only.length
      ? await pool.query('SELECT id, estimate_no, total_amount FROM estimates WHERE estimate_no IN (?)', [only])
      : await pool.query(
        `SELECT e.id, e.estimate_no, e.total_amount FROM estimates e
          WHERE EXISTS (SELECT 1 FROM audit_logs a
                         WHERE a.auditable_type = 'Estimate' AND a.event_type = 'Created' AND a.auditable_id = e.id)
            AND EXISTS (SELECT 1 FROM estimate_job_orders jo WHERE jo.estimate_id = e.id)
          ORDER BY e.id`
      );
    for (const no of only) if (!rows.find((r) => r.estimate_no === no)) console.log(`${no}: not found`);

    let changed = 0;
    for (const r of rows) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await refreshEstimateTotals(r.id, conn);
        const [[after]] = await conn.query('SELECT total_amount FROM estimates WHERE id = ?', [r.id]);
        const before = Number(r.total_amount || 0);
        const now = Number(after.total_amount || 0);
        if (Math.abs(before - now) >= 0.005) {
          changed += 1;
          console.log(`${r.estimate_no}: ${before.toFixed(2)} -> ${now.toFixed(2)}`);
        }
        if (DRY_RUN) await conn.rollback(); else await conn.commit();
      } catch (e) {
        await conn.rollback();
        console.log(`${r.estimate_no}: failed -- ${e.message}`);
      } finally { conn.release(); }
    }
    console.log(`\nchecked ${rows.length} estimate(s); ${changed} ${DRY_RUN ? 'would be' : 'were'} restated.`);
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
