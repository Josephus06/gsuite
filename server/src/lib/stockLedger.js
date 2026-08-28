// THE ONE DEFINITION OF WHAT MOVES STOCK.
//
// Every stock-mutating action this build performs, unioned into one movement ledger: what the
// Bin Card lists row by row, and what the Production screen's On Hand is the running total of.
// It lived inside routes/binCard.js while the Bin Card was its only reader; the Production view
// reads it now too, and two copies of "which tables count as a movement" would be free to drift
// the moment either gained a branch -- leaving the report and the shop floor quoting different
// stock for the same item, which is the exact confusion this whole area keeps producing.
//
// Each branch mirrors what its route actually does to stock:
//   - Receiving Report (RR-#)        -> qty_in at the receipt line's Location
//   - Vendor Return (VR-#)           -> qty_out at the return line's Location
//   - Item Fulfillment (IF-#)        -> qty_out at the TO's Withdraw From
//   - Item Receipt (IR-#)            -> qty_in at the TO's Transfer To
//   - Assembly Build (AB-#)          -> qty_out (material consumption) at the process Location
//   - Inventory Adjustment (IA-#, approved only) -> signed delta at the line's Location
//     (new_qty - qty_on_hand), never the raw adjust_qty_by -- that is in whatever unit Unit Used
//     says, while new_qty/qty_on_hand are already normalised to Base Unit by
//     inventoryAdjustments.js, so their difference is the true movement.
//
// PO Qty / Rec. Qty / Qty to Return are always entered in Purchase Unit (confirmed: "5 qty for
// tarpaulin" on a PO means 5 ROLL, not 5 SQFT) -- purchaseOrders.js's receive/return endpoints
// scale that by conversion_factor before touching stock, so those branches scale the same way
// and report the real Base Unit movement. Everything here is Base Unit.

// filterByItem pushes `item_id IN (?)` into every branch rather than wrapping the union and
// filtering outside it. Same rows either way, but each branch then uses its own item_id index
// instead of the whole union being materialised first: measured 789ms cold against 119ms for
// five items. A caller passing true must supply the id array SIX times, once per branch, in
// order.
function movementsSql(filterByItem = false) {
  const and = (alias) => (filterByItem ? ` AND ${alias}.item_id IN (?)` : '');
  const where = (alias) => (filterByItem ? ` WHERE ${alias}.item_id IN (?)` : '');
  return `
  SELECT r.date_created AS trans_date, r.receipt_no AS trans_no, 'Receiving Report' AS trans_type,
         po.po_no AS ref_no, rl.item_id, NULL AS from_location_id, NULL AS from_location_name,
         rl.location_id AS to_location_id, loc.location_name AS to_location_name,
         rl.qty_received * COALESCE(i0.conversion_factor, 1) AS qty_in, 0 AS qty_out, rl.rate, r.id AS sort_id, r.created_at AS sort_ts
  FROM purchase_order_receipt_lines rl
  JOIN purchase_order_receipts r ON r.id = rl.purchase_order_receipt_id
  JOIN purchase_orders po ON po.id = r.purchase_order_id
  LEFT JOIN locations loc ON loc.id = rl.location_id
  LEFT JOIN inventories i0 ON i0.id = rl.item_id${where('rl')}

  UNION ALL

  SELECT vr.date_created, vr.return_no, 'Vendor Return',
         po2.po_no, rl2.item_id, rl2.location_id, loc2.location_name, NULL, NULL,
         0, rl2.qty_returned * COALESCE(i1.conversion_factor, 1), rl2.rate, vr.id, vr.created_at
  FROM purchase_return_lines rl2
  JOIN purchase_returns vr ON vr.id = rl2.purchase_return_id
  JOIN purchase_orders po2 ON po2.id = vr.purchase_order_id
  LEFT JOIN locations loc2 ON loc2.id = rl2.location_id
  LEFT JOIN inventories i1 ON i1.id = rl2.item_id${where('rl2')}

  UNION ALL

  SELECT f.date_created, f.fulfillment_no, 'Item Fulfillment',
         tord.to_no, fl.item_id, tord.withdraw_from_location_id, wloc.location_name, NULL, NULL,
         0, fl.qty_fulfilled, i.average_cost, f.id, f.created_at
  FROM item_fulfillment_lines fl
  JOIN item_fulfillments f ON f.id = fl.item_fulfillment_id
  JOIN transfer_orders tord ON tord.id = f.transfer_order_id
  LEFT JOIN locations wloc ON wloc.id = tord.withdraw_from_location_id
  LEFT JOIN inventories i ON i.id = fl.item_id${where('fl')}

  UNION ALL

  SELECT r2.date_created, r2.receipt_no, 'Item Receipt',
         f2.fulfillment_no, rl3.item_id, NULL, NULL, tord2.transfer_to_location_id, tloc.location_name,
         rl3.qty_received, 0, i2.average_cost, r2.id, r2.created_at
  FROM item_receipt_lines rl3
  JOIN item_receipts r2 ON r2.id = rl3.item_receipt_id
  JOIN item_fulfillments f2 ON f2.id = r2.item_fulfillment_id
  JOIN transfer_orders tord2 ON tord2.id = r2.transfer_order_id
  LEFT JOIN locations tloc ON tloc.id = tord2.transfer_to_location_id
  LEFT JOIN inventories i2 ON i2.id = rl3.item_id${where('rl3')}

  UNION ALL

  SELECT ab.date_created, ab.ab_no, 'Assembly Build',
         jo.job_order_no, abl.item_id, abl.location_id, aloc.location_name, NULL, NULL,
         0, abl.total_qty_to_build, NULL, ab.id, ab.created_at
  FROM assembly_build_lines abl
  JOIN assembly_builds ab ON ab.id = abl.assembly_build_id
  JOIN job_orders jo ON jo.id = ab.job_order_id
  LEFT JOIN locations aloc ON aloc.id = abl.location_id
  WHERE abl.item_id IS NOT NULL AND abl.location_id IS NOT NULL${and('abl')}

  UNION ALL

  SELECT ia.date_created, ia.adjustment_no, 'Inventory Adjustment',
         NULL, ial.item_id,
         IF(ial.new_qty - ial.qty_on_hand < 0, ial.location_id, NULL), IF(ial.new_qty - ial.qty_on_hand < 0, iloc.location_name, NULL),
         IF(ial.new_qty - ial.qty_on_hand >= 0, ial.location_id, NULL), IF(ial.new_qty - ial.qty_on_hand >= 0, iloc.location_name, NULL),
         GREATEST(ial.new_qty - ial.qty_on_hand, 0), GREATEST(-(ial.new_qty - ial.qty_on_hand), 0), ial.est_unit_cost, ia.id, ia.updated_at
  FROM inventory_adjustment_lines ial
  JOIN inventory_adjustments ia ON ia.id = ial.inventory_adjustment_id
  LEFT JOIN locations iloc ON iloc.id = ial.location_id
  WHERE ia.status = 'approved'${and('ial')}
`;
}

// On-hand per item + location, as the running total of those movements -- the same number the
// Bin Card's last row shows for that pair, because it is the same rows summed.
//
// WHY THE MOVEMENTS AND NOT inventory_locations. The snapshot table was never populated by the
// year migrations, so it read 0 for almost the whole catalogue while the Bin Card could show
// stock -- a job order line for an item with rolls in the warehouse read as a full materials
// shortage. Seeding the snapshot from the source system's Stock Ledger was the other way to fix
// that, and it needs a complete, current import to stay right; deriving means the two screens
// cannot disagree and there is nothing to keep in sync.
//
// It inherits the movement history's own faults: where the migration is incomplete this total is
// wrong, and it can come out negative, which no shelf can be. That is visible rather than hidden,
// which is the point -- a wrong number that matches the ledger it came from can be chased down.
//
// A row's location is whichever end of the movement it happened at: qty_in rows carry a
// to_location, qty_out rows a from_location, and an Inventory Adjustment sets one or the other by
// the sign of its delta.
async function deriveOnHand(db, itemIds) {
  const ids = [...new Set((itemIds || []).filter((id) => id != null).map(Number))];
  const byPair = new Map();
  if (!ids.length) return byPair;
  const p6 = [ids, ids, ids, ids, ids, ids];

  const sumByPair = async (since) => {
    const [rows] = await db.query(
      `SELECT m.item_id, COALESCE(m.to_location_id, m.from_location_id) AS location_id,
              SUM(m.qty_in - m.qty_out) AS balance
         FROM (${movementsSql(true)}) m
        ${since ? 'WHERE m.trans_date >= ?' : ''}
        GROUP BY m.item_id, COALESCE(m.to_location_id, m.from_location_id)`,
      since ? [...p6, since] : p6
    );
    const map = new Map();
    for (const r of rows) {
      if (r.location_id != null) map.set(`${r.item_id}|${r.location_id}`, Number(r.balance));
    }
    return map;
  };

  // Anchored exactly as the Bin Card anchors: the source system's Beginning Balance, plus the
  // movements since. Same inputs, same arithmetic, so On Hand is the Bin Card's closing balance
  // for that item and warehouse rather than a second opinion about it.
  const [ledger] = await db.query(
    `SELECT lsl.inventory_id, lsl.location_id, lsl.window_from,
            lsl.beg_qty * COALESCE(NULLIF(i.conversion_factor, 0), 1) AS opening_base
       FROM live_stock_ledger lsl
       JOIN inventories i ON i.id = lsl.inventory_id
      WHERE lsl.inventory_id IN (?) AND lsl.location_id IS NOT NULL AND lsl.window_from IS NOT NULL`,
    [ids]
  ).catch(() => [[]]); // no ledger table yet: every pair falls back to full history below

  const anchors = new Map();
  for (const r of ledger) {
    anchors.set(`${r.inventory_id}|${r.location_id}`, {
      opening: Number(r.opening_base) || 0,
      from: String(r.window_from).slice(0, 10),
    });
  }

  // Every row of one ledger import shares a window, so this is one cutoff in practice; looping
  // keeps it correct if a partial re-import ever leaves two.
  const cutoffs = [...new Set([...anchors.values()].map((a) => a.from))];
  const since = new Map();
  for (const c of cutoffs) since.set(c, await sumByPair(c));

  // Pairs the ledger knows about are anchored -- including ones with no movements at all, whose
  // on-hand is simply their opening balance, which a movements-only sum would report as nothing.
  for (const [pair, a] of anchors) {
    byPair.set(pair, a.opening + (since.get(a.from)?.get(pair) ?? 0));
  }

  // Anything the ledger does not cover falls back to the full movement history -- the same view
  // the Bin Card falls back to, and just as unreconciled.
  if (anchors.size === 0 || cutoffs.length === 0) {
    for (const [pair, bal] of await sumByPair(null)) byPair.set(pair, bal);
  } else {
    for (const [pair, bal] of await sumByPair(null)) if (!byPair.has(pair)) byPair.set(pair, bal);
  }
  return byPair;
}

module.exports = { movementsSql, deriveOnHand };
