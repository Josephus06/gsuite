const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { movementsSql } = require('../lib/stockLedger');

const router = express.Router();
const ROUTE = '/bin-card-reports';

// Real Bin Card (Master Lists > Inventory Reports > Bin Card): a chronological,
// per-Item + per-Location transaction ledger with a running balance -- distinct from
// Stock Ledger (a Beginning/Input/Output/Ending *summary*, left untouched). Confirmed
// against the live system's `generate_bin_card` response shape: each row is one
// transaction (Trans #), tagged with a Ref # (the transaction it came from), a
// Withdraw From / Transfer To location pair, Qty In/Out, Rate, and a running Balance.
//
// The movements themselves are defined once in lib/stockLedger.js -- which branch of the build
// counts as a stock movement, and in which unit -- because the Production screen's On Hand is now
// the running total of the same rows. Two copies would let the report and the shop floor quote
// different stock for one item.
const UNION_SQL = movementsSql();

// WHY THIS REPORT NEEDS AN OPENING BALANCE.
//
// The running balance above starts at zero and adds whatever movements this build happens to
// hold -- which is only the transactions the year migrations brought over. Wherever that history
// is incomplete the total drifts, and it drifts both ways: measured across the 6,644 item +
// location pairs live's Stock Ledger covers, 3,648 of them (55%) disagreed with live's own
// figure. 1,484 showed stock where live says the bin is empty, and 1,094 showed a NEGATIVE
// balance, which no warehouse can hold. MATTE LAMINATING FILM read -286,311 LINCH against live's
// 15.87 rolls; IMARI 113 GSM read +77 SHT against live's 0.
//
// A ledger reconstructed from movements alone cannot fix this, because the missing part is the
// balance the item already had before the first movement we hold. live_stock_ledger carries
// exactly that -- Beginning Qty per item + location, as at the start of the window it was
// imported for -- so the report opens from that figure and replays only the movements inside the
// window, instead of replaying an incomplete decade from zero.
//
// ?full=1 gives the old behaviour, every movement from zero. It is the honest view of what this
// database actually holds, which is worth keeping for anyone reconciling the migration itself --
// but it is not the view to hand someone asking what is on the shelf.
//
// A ledger imported before window_from existed cannot be anchored (the Beginning Qty is real but
// nothing records which date it belongs to), so those fall back to the full view and say so via
// `reconciled: false` rather than quietly anchoring to a date that was guessed.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { item_id: itemId, location_id: locationId, as_of: asOf, full } = req.query;
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

    // live's own Beginning Qty for this item (and location, when one is chosen), quoted in the
    // item's Stock Unit like every other figure in that table, so it comes up to Base Unit the
    // same way the movements do.
    //
    // Asked for only when it can be used, and never allowed to take the report down with it.
    // window_from is a column import-stock-ledger.js adds on its next run, so between deploying
    // this and re-importing, an install's ledger does not have it yet -- selecting it there threw
    // "Unknown column 'window_from'" and the whole Bin Card 500'd. A report that cannot anchor
    // should fall back to the view it already had, not stop working, so any failure to read the
    // anchor means there is no anchor.
    let opening = null;
    if (full !== '1') {
      try {
        [[opening]] = await pool.query(
          `SELECT SUM(beg_qty) AS beg_stock, MIN(window_from) AS window_from, MAX(window_to) AS window_to
             FROM live_stock_ledger
            WHERE inventory_id = ?${locationId ? ' AND location_id = ?' : ''}`,
          locationId ? [itemId, locationId] : [itemId]
        );
      } catch (err) {
        opening = null;
      }
    }
    const windowFrom = opening?.window_from ? String(opening.window_from).slice(0, 10) : null;
    // Asked "as of" a date before the opening balance was struck, the anchor is no help -- it
    // describes a later moment than the question. Answer from full history instead, and say so,
    // rather than heading the report with a Beginning Balance dated after the date asked for.
    const asOfBeforeWindow = !!(asOf && windowFrom && String(asOf).slice(0, 10) < windowFrom);
    const reconciled = !!windowFrom && full !== '1' && !asOfBeforeWindow;
    const openingBase = reconciled ? Number(opening.beg_stock || 0) * conversionFactor : 0;

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
    // Anchored view: only the movements the opening balance does not already account for.
    if (reconciled) {
      where.push('trans_date >= ?');
      params.push(windowFrom);
    }

    // sort_id is only meaningful as a tie-breaker *within* one transaction type (it's an
    // auto-increment id from a different table per branch of the UNION, so comparing it
    // across branches is meaningless) -- order strictly by the real timestamp instead.
    const [rows] = await pool.query(
      `SELECT * FROM (${UNION_SQL}) movements WHERE ${where.join(' AND ')} ORDER BY trans_date, sort_ts`,
      params
    );

    let balanceBase = openingBase;
    const withBalance = rows.map((r) => {
      balanceBase += Number(r.qty_in) - Number(r.qty_out);
      return { ...r, balance_base: balanceBase, balance_stock: balanceBase / conversionFactor };
    });

    // The opening balance is itself a row of the ledger -- the one every other balance is
    // measured from -- so it is sent as one rather than as a number the reader has to hold in
    // their head. It sorts oldest, which after the reverse below puts it at the very end.
    if (reconciled) {
      withBalance.unshift({
        trans_date: windowFrom,
        trans_no: null,
        trans_type: 'Beginning Balance',
        ref_no: null,
        item_id: Number(itemId),
        from_location_id: null,
        from_location_name: null,
        to_location_id: null,
        to_location_name: null,
        qty_in: null,
        qty_out: null,
        rate: null,
        balance_base: openingBase,
        balance_stock: openingBase / conversionFactor,
        is_opening: true,
      });
    }

    // A running balance can only be accumulated oldest-first, but nobody opens a bin card to read
    // 2021: the question is almost always "what is this item doing now", and with 149 pages of
    // history that answer sat on the last page. Reversed after the balances are computed, so page
    // one is the most recent movement and each row still carries the balance as at its own date.
    withBalance.reverse();

    res.json({
      stock_unit_label: unitInfo.stock_unit_title ? `${unitInfo.stock_unit_title} (${unitInfo.stock_unit_code})` : (unitInfo.stock_unit_code || 'Stock Unit'),
      base_unit_label: unitInfo.base_unit_title ? `${unitInfo.base_unit_title} (${unitInfo.base_unit_code})` : (unitInfo.base_unit_code || 'Base Unit'),
      conversion_factor: conversionFactor,
      // What the reader needs to know about which view they are looking at: whether it is
      // anchored to live's own opening balance, and from when.
      reconciled,
      window_from: reconciled ? windowFrom : null,
      window_to: opening?.window_to ? String(opening.window_to).slice(0, 10) : null,
      opening_balance_base: reconciled ? openingBase : null,
      opening_balance_stock: reconciled ? openingBase / conversionFactor : null,
      rows: withBalance,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
