const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { buildTrialBalance, buildBalanceSheet, buildIncomeStatement, buildGeneralLedger } = require('../lib/reportsEngine');

const router = express.Router();

function today() { return new Date().toISOString().slice(0, 10); }

router.get('/trial-balance', requireAuth, requirePermission('/reports/trial-balance', 'can_view'), async (req, res, next) => {
  try {
    res.json(await buildTrialBalance(req.query.asOf || today()));
  } catch (err) {
    next(err);
  }
});

const VALID_BREAKDOWNS = ['total', 'months', 'location', 'department'];
router.get('/income-statement', requireAuth, requirePermission('/reports/income-statement', 'can_view'), async (req, res, next) => {
  try {
    const breakdown = VALID_BREAKDOWNS.includes(req.query.breakdown) ? req.query.breakdown : 'total';
    res.json(await buildIncomeStatement(req.query.asOf || today(), req.query.from || null, breakdown));
  } catch (err) {
    next(err);
  }
});

router.get('/balance-sheet', requireAuth, requirePermission('/reports/balance-sheet', 'can_view'), async (req, res, next) => {
  try {
    res.json(await buildBalanceSheet(req.query.asOf || today()));
  } catch (err) {
    next(err);
  }
});

router.get('/general-ledger', requireAuth, requirePermission('/reports/general-ledger', 'can_view'), async (req, res, next) => {
  try {
    res.json(await buildGeneralLedger(req.query.asOf || today()));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
