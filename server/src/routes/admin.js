const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { syncNewEstimates } = require('../lib/liveEstimateSync');
const { syncStatuses, SYNCABLE } = require('../lib/liveStatusSync');

const router = express.Router();

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
router.post('/sync-status', requireAuth, requireSystemAdmin, async (req, res, next) => {
  try {
    const modules = Array.isArray(req.body?.modules) ? req.body.modules : undefined;
    const summary = await syncStatuses({ modules });
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.get('/sync-status/modules', requireAuth, requireSystemAdmin, (req, res) => {
  res.json({ modules: SYNCABLE });
});

module.exports = router;
