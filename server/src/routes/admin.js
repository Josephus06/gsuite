const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { syncNewEstimates } = require('../lib/liveEstimateSync');
const { syncStatuses, SYNCABLE } = require('../lib/liveStatusSync');
const { collect } = require('../lib/systemHealth');
const { rollupJoQuantities } = require('../lib/joProductionRollup');

const router = express.Router();

// The processes backfill (import-jo-processes.js) is a long live-fetch job, so it runs detached in
// the background rather than blocking the sync request. Debounced so rapid re-clicks don't pile up
// duplicate runs (the script is resumable/idempotent regardless).
let lastProcessesSpawn = 0;
function startProcessesBackfill() {
  if (Date.now() - lastProcessesSpawn < 10 * 60 * 1000) return false; // already kicked off recently
  lastProcessesSpawn = Date.now();
  const script = path.join(__dirname, '..', 'db', 'import-jo-processes.js');
  const child = spawn(process.execPath, [script], {
    detached: true, stdio: 'ignore', cwd: path.join(__dirname, '..', '..'), env: process.env,
  });
  child.unref();
  return true;
}

// Checked fresh against the DB rather than trusted off the JWT, same discipline as the
// sales-visibility scope check -- account_type can change after the token was issued.
async function requireSystemAdmin(req, res, next) {
  try {
    const [[user]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [req.user.id]);
    if (!user || user.account_type !== 'System Admin') {
      return res.status(403).json({ error: 'System Admin only' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

router.post('/sync-estimates', requireAuth, requireSystemAdmin, async (req, res, next) => {
  try {
    const summary = await syncNewEstimates();
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// Refresh status + totals of already-migrated transactions from live, in place. Optional body
// { modules: ['sales_orders', ...] } to scope to specific modules; omitted -> all syncable ones.
// On a full "sync all" it also rolls up the JO built/inspected/delivered quantities (fast, local)
// and kicks off the JO-processes backfill in the background for any JOs still missing them.
router.post('/sync-status', requireAuth, requireSystemAdmin, async (req, res, next) => {
  try {
    const modules = Array.isArray(req.body?.modules) ? req.body.modules : undefined;
    const summary = await syncStatuses({ modules });

    let quantities = null; let processes = null;
    if (!modules) {
      quantities = await rollupJoQuantities();
      const [[m]] = await pool.query(
        'SELECT COUNT(*) n FROM job_orders jo WHERE NOT EXISTS (SELECT 1 FROM job_order_processes p WHERE p.job_order_id = jo.id)'
      );
      const missing = m.n;
      processes = { missing, backfill_started: missing > 0 ? startProcessesBackfill() : false };
    }

    res.json({ ...summary, quantities, processes });
  } catch (err) {
    next(err);
  }
});

router.get('/sync-status/modules', requireAuth, requireSystemAdmin, (req, res) => {
  res.json({ modules: SYNCABLE });
});

// Admin > System Health. What this machine and its database are doing right now, plus a short
// rolling history so a spike is visible rather than just a number that happens to be high at the
// moment you looked. Restricted to System Admin: it reports host, disk and database internals.
router.get('/system-health', requireAuth, requireSystemAdmin, async (req, res, next) => {
  try {
    res.json(await collect());
  } catch (err) { next(err); }
});

module.exports = router;
