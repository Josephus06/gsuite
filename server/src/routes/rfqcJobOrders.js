const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { listRows, filterOptions, sendExtract } = require('../lib/reworkJobOrderList');

const router = express.Router();
const ROUTE = '/rfqc-job-orders';

// RFQC (rework-from-quality-check) job orders -- raised during Quality Inspection for the RMA (failed/damaged) qty; approved/built/inspected from the JO view.
// Read-only browse. Filters and Extract are shared with the other rework list (lib/reworkJobOrderList.js).
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try { res.json(await listRows(req, 'RFQC')); } catch (err) { next(err); }
});

router.get('/filter-options', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try { res.json(await filterOptions(req, 'RFQC')); } catch (err) { next(err); }
});

// Extract: every RFQC under the list's current filters, as a workbook.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    await sendExtract(res, await listRows(req, 'RFQC'), 'RFQC');
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

module.exports = router;
