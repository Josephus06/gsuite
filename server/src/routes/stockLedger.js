const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const {
  movementsQuery, ledgerQuery, shapeLedgerRow, SOURCES, SNAPSHOT_FROM, today,
} = require('../lib/stockMovements');

const router = express.Router();
const ROUTE = '/stock-ledger-reports';

// "Inventory > Inventory Reports > Stock Ledger", computed from this app's own stock movements.
//
// It used to be served verbatim from `live_stock_ledger`, a frozen snapshot of live's report for
// 2026-01-01..2026-07-28. Nothing here ever posted to it, so receiving reports never showed up
// and the date filter did nothing. Now:
//
//   Beginning = the snapshot's beg_qty (the only source for balances predating the migration)
//               plus every movement from the snapshot date up to the day before `from`
//   Input / Output = movements inside [from, to], from src/lib/stockMovements.js
//   Ending    = Beginning + Input - Output
//
// The snapshot is kept strictly as the opening balance. Its own Input/Output columns are no
// longer served, because they describe live's window rather than the one being asked for.
//
// Only stock-carrying items appear: services, non-inventory items, landed costs and discounts
// are excluded, as they have no quantity on hand to ledger.
//
// A KNOWN LIMIT, stated rather than hidden. Reconciled against the snapshot over its own window,
// the computed Input matches live on 97% of item+location cells and Output on 88%. The gap is
// production consumption: assembly_build_lines.qty is the job order's material requirement
// repeated on every build of that order, so multi-build job orders overstate the draw. Receipts,
// transfers, returns and adjustments are exact. `/movements` shows the documents behind any
// figure, which is how to check one.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    // "As of" sends only `to`, meaning everything up to that date -- so the period opens at the
    // snapshot date, which is as far back as the data goes.
    const { sql, params } = ledgerQuery({
      itemId: req.query.item_id || null,
      locationId: req.query.location_id || null,
      from: req.query.from || null,
      to: req.query.to || null,
    });
    const [rows] = await pool.query(sql, params);
    res.json(rows.map(shapeLedgerRow));
  } catch (err) {
    next(err);
  }
});

// The documents behind a cell -- every movement for one item + location over the period, newest
// first. This is what makes a figure checkable: a receiving report that raised stock is now a row
// you can point at, which was the whole complaint about the old frozen report.
router.get('/movements', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const itemId = req.query.item_id || null;
    if (!itemId) return res.status(400).json({ message: 'item_id is required' });
    const to = req.query.to || today();
    const from = req.query.from && req.query.from > SNAPSHOT_FROM ? req.query.from : SNAPSHOT_FROM;

    const mv = movementsQuery({ itemId, locationId: req.query.location_id || null, from, to });
    const [rows] = await pool.query(
      `SELECT m.*, l.location_name
         FROM (${mv.sql}) m
         LEFT JOIN locations l ON l.id = m.location_id
        ORDER BY m.move_date DESC, m.source
        LIMIT 500`,
      mv.params
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// Lets the UI name the sources it is summing without hard-coding them a second time.
router.get('/sources', requireAuth, requirePermission(ROUTE, 'can_view'), (_req, res) => {
  res.json(SOURCES.map((s) => ({ key: s.key, label: s.label })));
});

module.exports = router;
