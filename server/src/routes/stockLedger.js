const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/stock-ledger-reports';

// Mirrors the real system's "Inventory > Inventory Reports > Stock Ledger" screen: for
// each Item + Location, Beginning balance / Input / Output / Ending balance. The real
// report computes Input/Output from actual stock transactions (Item Receipts, Transfer
// Orders, Item Fulfillments, ...) over the selected period -- none of those
// transactional modules are modeled in this build, so there's no movement history to
// sum. Beginning/Input/Output are always blank/zero here; Ending Qty On-hand/Ave Cost/
// Value are the current live snapshot from inventory_locations/inventories, which is
// the most honest thing this build can show without fabricating transaction data.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { item_id: itemId, location_id: locationId } = req.query;

    const where = [];
    const params = [];
    if (itemId) { where.push('i.id = ?'); params.push(itemId); }
    // Location filtering has to tolerate items with no inventory_locations row at all
    // (LEFT JOIN below), so this matches on the joined location id OR excludes items
    // that have no rows for that location.
    if (locationId) { where.push('il.location_id = ?'); params.push(locationId); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // LEFT JOIN, not INNER -- an item with no inventory_locations row yet (never had a
    // stock count entered) still belongs in the report, just with no location sub-rows.
    const [rows] = await pool.query(
      `SELECT i.id AS inventory_id, i.item_code, u.title AS unit_title,
              l.id AS location_id, l.location_name,
              il.qty_on_hand AS ending_qty, i.average_cost AS ending_cost
       FROM inventories i
       LEFT JOIN inventory_locations il ON il.inventory_id = i.id
       LEFT JOIN locations l ON l.id = il.location_id
       LEFT JOIN units_of_measure u ON u.id = i.base_unit_id
       ${whereSql}
       ORDER BY i.item_code, l.location_name`,
      params
    );

    res.json(rows.map((r) => ({
      ...r,
      beg_qty: null,
      beg_cost: null,
      beg_value: null,
      input: 0,
      value_of_inputs: 0,
      output: 0,
      value_of_outputs: 0,
      ending_value: r.ending_qty ? Number(r.ending_qty) * Number(r.ending_cost || 0) : null,
    })));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
