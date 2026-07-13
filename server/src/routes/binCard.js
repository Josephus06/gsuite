const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/bin-card-reports';

// Real Bin Card (Master Lists > Inventory Reports > Bin Card): a chronological,
// per-Item + per-Location transaction ledger with a running balance -- distinct from
// Stock Ledger (a Beginning/Input/Output/Ending *summary*, left untouched). Confirmed
// against the live system's `generate_bin_card` response shape: each row is one
// transaction (Trans #), tagged with a Ref # (the transaction it came from), a
// Withdraw From / Transfer To location pair, Qty In/Out, Rate, and a running Balance.
//
// This must reconcile with the live inventory_locations.qty_on_hand snapshot (Stock
// Ledger's Ending Qty) -- so every one of this build's stock-mutating actions is unioned
// in here as its own transaction type, mirroring exactly what each route actually does
// to qty_on_hand:
//   - Purchase Order Receiving Report (RR-#)  -> qty_in at the receipt line's Location
//   - Vendor Return (VR-#)                    -> qty_out at the return line's Location
//   - Item Fulfillment (IF-#)                 -> qty_out at the TO's Withdraw From
//   - Item Receipt (IR-#)                     -> qty_in at the TO's Transfer To
//   - Assembly Build (AB-#)                   -> qty_out (material consumption) at the process Location
//   - Inventory Adjustment (IA-#, approved only) -> signed delta at the line's Location
//     (new_qty - qty_on_hand), never the raw adjust_qty_by -- that's in whatever unit
//     Unit Used says (Stock or Base), while new_qty/qty_on_hand are already normalized to
//     Base Unit by inventoryAdjustments.js, so their difference is the true movement.
//
// PO Qty/Rec. Qty/Qty to Return are always entered in Purchase Unit (confirmed: "5 qty
// for tarpaulin" on a PO means 5 ROLL, not 5 SQFT) -- purchaseOrders.js's receive/return
// endpoints scale that by the item's conversion_factor before touching qty_on_hand, so
// the Receiving Report/Vendor Return branches below scale qty_received/qty_returned the
// same way to report the actual Base Unit movement, matching what really hit stock.
const UNION_SQL = `
  SELECT r.date_created AS trans_date, r.receipt_no AS trans_no, 'Receiving Report' AS trans_type,
         po.po_no AS ref_no, rl.item_id, NULL AS from_location_id, NULL AS from_location_name,
         rl.location_id AS to_location_id, loc.location_name AS to_location_name,
         rl.qty_received * COALESCE(i0.conversion_factor, 1) AS qty_in, 0 AS qty_out, rl.rate, r.id AS sort_id, r.created_at AS sort_ts
  FROM purchase_order_receipt_lines rl
  JOIN purchase_order_receipts r ON r.id = rl.purchase_order_receipt_id
  JOIN purchase_orders po ON po.id = r.purchase_order_id
  LEFT JOIN locations loc ON loc.id = rl.location_id
  LEFT JOIN inventories i0 ON i0.id = rl.item_id

  UNION ALL

  SELECT vr.date_created, vr.return_no, 'Vendor Return',
         po2.po_no, rl2.item_id, rl2.location_id, loc2.location_name, NULL, NULL,
         0, rl2.qty_returned * COALESCE(i1.conversion_factor, 1), rl2.rate, vr.id, vr.created_at
  FROM purchase_return_lines rl2
  JOIN purchase_returns vr ON vr.id = rl2.purchase_return_id
  JOIN purchase_orders po2 ON po2.id = vr.purchase_order_id
  LEFT JOIN locations loc2 ON loc2.id = rl2.location_id
  LEFT JOIN inventories i1 ON i1.id = rl2.item_id

  UNION ALL

  SELECT f.date_created, f.fulfillment_no, 'Item Fulfillment',
         tord.to_no, fl.item_id, tord.withdraw_from_location_id, wloc.location_name, NULL, NULL,
         0, fl.qty_fulfilled, i.average_cost, f.id, f.created_at
  FROM item_fulfillment_lines fl
  JOIN item_fulfillments f ON f.id = fl.item_fulfillment_id
  JOIN transfer_orders tord ON tord.id = f.transfer_order_id
  LEFT JOIN locations wloc ON wloc.id = tord.withdraw_from_location_id
  LEFT JOIN inventories i ON i.id = fl.item_id

  UNION ALL

  SELECT r2.date_created, r2.receipt_no, 'Item Receipt',
         f2.fulfillment_no, rl3.item_id, NULL, NULL, tord2.transfer_to_location_id, tloc.location_name,
         rl3.qty_received, 0, i2.average_cost, r2.id, r2.created_at
  FROM item_receipt_lines rl3
  JOIN item_receipts r2 ON r2.id = rl3.item_receipt_id
  JOIN item_fulfillments f2 ON f2.id = r2.item_fulfillment_id
  JOIN transfer_orders tord2 ON tord2.id = r2.transfer_order_id
  LEFT JOIN locations tloc ON tloc.id = tord2.transfer_to_location_id
  LEFT JOIN inventories i2 ON i2.id = rl3.item_id

  UNION ALL

  SELECT ab.date_created, ab.ab_no, 'Assembly Build',
         jo.job_order_no, abl.item_id, abl.location_id, aloc.location_name, NULL, NULL,
         0, abl.total_qty_to_build, NULL, ab.id, ab.created_at
  FROM assembly_build_lines abl
  JOIN assembly_builds ab ON ab.id = abl.assembly_build_id
  JOIN job_orders jo ON jo.id = ab.job_order_id
  LEFT JOIN locations aloc ON aloc.id = abl.location_id
  WHERE abl.item_id IS NOT NULL AND abl.location_id IS NOT NULL

  UNION ALL

  SELECT ia.date_created, ia.adjustment_no, 'Inventory Adjustment',
         NULL, ial.item_id,
         IF(ial.new_qty - ial.qty_on_hand < 0, ial.location_id, NULL), IF(ial.new_qty - ial.qty_on_hand < 0, iloc.location_name, NULL),
         IF(ial.new_qty - ial.qty_on_hand >= 0, ial.location_id, NULL), IF(ial.new_qty - ial.qty_on_hand >= 0, iloc.location_name, NULL),
         GREATEST(ial.new_qty - ial.qty_on_hand, 0), GREATEST(-(ial.new_qty - ial.qty_on_hand), 0), ial.est_unit_cost, ia.id, ia.updated_at
  FROM inventory_adjustment_lines ial
  JOIN inventory_adjustments ia ON ia.id = ial.inventory_adjustment_id
  LEFT JOIN locations iloc ON iloc.id = ial.location_id
  WHERE ia.status = 'approved'
`;

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { item_id: itemId, location_id: locationId, as_of: asOf } = req.query;
    if (!itemId) return res.status(400).json({ error: 'item_id is required' });

    // Every qty this build actually writes to inventory_locations.qty_on_hand is in the
    // item's Base Unit (purchaseOrders.js's receive/return scale Purchase Unit qty up to
    // Base Unit before touching stock) -- confirmed against the live system, whose own
    // Bin Card records Qty In/Out in Base Unit too and derives the Stock Unit balance as
    // Base Unit balance / Conversion Factor (e.g. 1 ROLL = 1344.8 SQFT). So Balance(Base
    // Unit) is the raw running total (what already reconciles with qty_on_hand);
    // Balance(Stock Unit) is just that divided down.
    const [[unitInfo]] = await pool.query(
      `SELECT i.conversion_factor, su.code AS stock_unit_code, su.title AS stock_unit_title,
              bu.code AS base_unit_code, bu.title AS base_unit_title
       FROM inventories i
       LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id
       LEFT JOIN units_of_measure bu ON bu.id = i.base_unit_id
       WHERE i.id = ?`,
      [itemId]
    );
    if (!unitInfo) return res.status(404).json({ error: 'Item not found' });
    const conversionFactor = Number(unitInfo.conversion_factor) || 1;

    const where = ['item_id = ?'];
    const params = [itemId];
    if (locationId) {
      where.push('(to_location_id = ? OR from_location_id = ?)');
      params.push(locationId, locationId);
    }
    if (asOf) {
      where.push('trans_date <= ?');
      params.push(asOf);
    }

    // sort_id is only meaningful as a tie-breaker *within* one transaction type (it's an
    // auto-increment id from a different table per branch of the UNION, so comparing it
    // across branches is meaningless) -- order strictly by the real timestamp instead.
    const [rows] = await pool.query(
      `SELECT * FROM (${UNION_SQL}) movements WHERE ${where.join(' AND ')} ORDER BY trans_date, sort_ts`,
      params
    );

    let balanceBase = 0;
    const withBalance = rows.map((r) => {
      balanceBase += Number(r.qty_in) - Number(r.qty_out);
      return { ...r, balance_base: balanceBase, balance_stock: balanceBase / conversionFactor };
    });

    res.json({
      stock_unit_label: unitInfo.stock_unit_title ? `${unitInfo.stock_unit_title} (${unitInfo.stock_unit_code})` : (unitInfo.stock_unit_code || 'Stock Unit'),
      base_unit_label: unitInfo.base_unit_title ? `${unitInfo.base_unit_title} (${unitInfo.base_unit_code})` : (unitInfo.base_unit_code || 'Base Unit'),
      conversion_factor: conversionFactor,
      rows: withBalance,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
