const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { syncNewEstimates } = require('../lib/liveEstimateSync');

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

module.exports = router;
