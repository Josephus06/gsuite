const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/stock-ledger-reports';

// "Inventory > Inventory Reports > Stock Ledger". Served verbatim from the live report, which
// is imported into live_stock_ledger by src/db/import-stock-ledger.js (generate_stock_ledger_v2).
// That gives the exact live figures per item + location -- Beginning / Input / Output / Ending
// with values -- including the Beginning balances that can't be derived from the migrated
// transactions alone. The imported snapshot covers one fixed period (the import window), so the
// on-screen Date filter is informational; Item/Location filters apply.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { item_id: itemId, location_id: locationId } = req.query;
    const where = [];
    const params = [];
    if (itemId) { where.push('sl.inventory_id = ?'); params.push(itemId); }
    if (locationId) { where.push('sl.location_id = ?'); params.push(locationId); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT sl.inventory_id, sl.item_pk, sl.item_code, sl.unit_title,
              sl.location_id, sl.location_pk, sl.location,
              sl.beg_qty, sl.beg_cost, sl.beg_value,
              sl.input, sl.input_value, sl.output, sl.output_value,
              sl.ending_qty, sl.ending_cost, sl.ending_value
         FROM live_stock_ledger sl
         ${whereSql}
        ORDER BY sl.item_code, sl.location`,
      params
    );

    // Shape for the report (item header + per-location rows). Fall back to the live pk for
    // grouping/keys when an item or location didn't resolve to a local id.
    res.json(rows.map((r) => ({
      inventory_id: r.inventory_id || r.item_pk,
      item_code: r.item_code,
      unit_title: r.unit_title,
      location_id: r.location_id || r.location_pk,
      location_name: r.location,
      beg_qty: r.beg_qty, beg_cost: r.beg_cost, beg_value: r.beg_value,
      input: r.input, value_of_inputs: r.input_value,
      output: r.output, value_of_outputs: r.output_value,
      ending_qty: r.ending_qty, ending_cost: r.ending_cost, ending_value: r.ending_value,
    })));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
