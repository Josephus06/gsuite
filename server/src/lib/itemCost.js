const { deriveOnHand } = require('./stockLedger');

// Average Cost and Last Purchase Price, kept up to date by purchasing (2026-11-25).
//
// Until now nothing in T1S wrote either: both were copied once from the source system
// (db/backfill-material-costing.js), so an item first bought in T1S had none, and an older item
// kept the source's figure however much it was bought since. Average Cost is what stock leaving is
// valued at (lib/glImpact.js, transfers, inventory adjustments) and the estimate's material cost
// (shared/costing.js), so a blank one valued it at 0.
//
// THE RULE (user, 2026-11-25): moving weighted average at the PO price.
//   - A receipt adds its quantity at its Net of Tax (the PO price less discount, before VAT):
//       new average = (on hand x old average + received x receipt price) / (on hand + received)
//     Nothing on hand (or no average yet) -> the receipt price itself.
//   - Editing a receipt takes the old line out and puts the new one in; a vendor return takes the
//     returned quantity out at the price it was received at.
//   - A later vendor bill at a different price does NOT re-cost (user's choice).
//   - Last Purchase Price / Date follow the latest receipt by date.
//
// UNITS. PO quantities are always in the item's Purchase Unit, and average_cost is per Purchase
// Unit too -- shared/costing.js divides it by conversion_factor for the per-base-unit cost. On
// hand comes from the stock movements in Base Unit (lib/stockLedger.js, the Bin Card's number,
// not inventory_locations), so it is divided by conversion_factor here.

const NON_STOCK_TYPES = new Set(['Service', 'Non-Inventory', 'Landed Cost', 'Discount']);
const round4 = (v) => Math.round(v * 10000) / 10000;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

/**
 * The average after a stock document, per Purchase Unit. Pure.
 * onHand: quantity on hand before the document, in Purchase Unit. average: current average.
 * remove*: a quantity leaving at its own value (an edited receipt's old line, a vendor return).
 * add*: a quantity arriving at its value (a receipt).
 */
function nextAverage({ onHand, average, removeQty = 0, removeValue = 0, addQty = 0, addValue = 0 }) {
  // Stock with no known cost cannot be averaged in: it would drag the price toward 0.
  let qty = onHand > 1e-9 && average > 0 ? onHand : 0;
  let value = qty * average;
  if (removeQty > 0 && qty > 0) {
    qty -= removeQty;
    value -= removeValue;
    if (qty <= 1e-9 || value <= 0) { qty = 0; value = 0; }
  }
  if (addQty > 0) { qty += addQty; value += addValue; }
  return qty > 1e-9 ? round4(value / qty) : average;
}

async function onHandInPurchaseUnits(conn, itemId, conversionFactor) {
  const balances = await deriveOnHand(conn, [itemId]);
  let base = 0;
  for (const v of balances.values()) base += v;
  return base / (conversionFactor || 1);
}

/**
 * Re-cost one item for a purchasing document. Call it inside the document's transaction and
 * BEFORE the document's own line is written, so "on hand" does not already include it.
 * Returns { before, after } or null for a non-stock item.
 */
async function applyPurchaseCost(conn, {
  itemId, userId = null, ref = '', date = null, removeQty = 0, removeValue = 0, addQty = 0, addValue = 0,
}) {
  const [[item]] = await conn.query(
    `SELECT id, item_type, average_cost, last_purchase_price, last_purchase_date, conversion_factor
       FROM inventories WHERE id = ? FOR UPDATE`, [itemId]);
  if (!item || NON_STOCK_TYPES.has(item.item_type)) return null;
  const conversion = num(item.conversion_factor) || 1;
  const before = num(item.average_cost);
  const onHand = await onHandInPurchaseUnits(conn, itemId, conversion);
  const after = nextAverage({ onHand, average: before, removeQty, removeValue, addQty, addValue });

  const sets = [];
  const params = [];
  const audit = [];
  if (Math.abs(after - before) > 0.00005 || (item.average_cost === null && addQty > 0)) {
    sets.push('average_cost = ?'); params.push(after);
    audit.push(['average_cost', item.average_cost, after]);
  }
  const day = date ? String(date).slice(0, 10) : null;
  const lastDay = item.last_purchase_date ? String(item.last_purchase_date).slice(0, 10) : null;
  if (addQty > 0 && day && (!lastDay || day >= lastDay)) {
    const price = round4(addValue / addQty);
    if (Math.abs(price - num(item.last_purchase_price)) > 0.00005 || item.last_purchase_price === null) {
      sets.push('last_purchase_price = ?'); params.push(price);
      audit.push(['last_purchase_price', item.last_purchase_price, price]);
    }
    if (day !== lastDay) { sets.push('last_purchase_date = ?'); params.push(day); }
  }
  if (sets.length) {
    await conn.query(`UPDATE inventories SET ${sets.join(', ')} WHERE id = ?`, [...params, itemId]);
    // event_type is a fixed list ('Updated' fits); the document that caused it rides in field_name.
    for (const [field, oldValue, newValue] of audit) {
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('Inventory', ?, 'Updated', ?, ?, ?, ?)`,
        [itemId, `${field}${ref ? ` (${ref})` : ''}`.slice(0, 150),
          oldValue === null ? null : String(oldValue), String(newValue), userId]);
    }
  }
  return { before, after, onHand };
}

module.exports = { nextAverage, applyPurchaseCost, onHandInPurchaseUnits, NON_STOCK_TYPES };
