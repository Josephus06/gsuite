const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { listRows, filterOptions, sendExtract } = require('../lib/reworkJobOrderList');

const router = express.Router();
const ROUTE = '/rwip-job-orders';

// RWIP (rework-in-progress) job orders -- raised off a mother JO; created/approved/completed from the Production JO view.
// Read-only browse. Filters and Extract are shared with the other rework list (lib/reworkJobOrderList.js).
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try { res.json(await listRows(req, 'RWIP')); } catch (err) { next(err); }
});

router.get('/filter-options', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try { res.json(await filterOptions(req, 'RWIP')); } catch (err) { next(err); }
});

// Extract: every RWIP under the list's current filters, as a workbook.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    await sendExtract(res, await listRows(req, 'RWIP'), 'RWIP');
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

module.exports = router;
