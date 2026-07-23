// Inventories/Non-Inventories/Service Items all live in the one `inventories` table,
// told apart only by `item_type` (see the note above the Service Items block in
// schema.sql). A Service item is a charge for work done -- labor, installation, a
// subcontracted service -- not a thing sitting on a shelf, so none of the stock
// machinery applies to it: it has no qty_on_hand anywhere, can never be committed out of
// a location's shared pool, and moving it between warehouses moves nothing physical.
//
// Every stock gate in the transfer-order flow (Committed, on-hand at Withdraw From, and
// Reallocate itself) therefore has to be skipped for these -- otherwise a Service line
// sits permanently unfulfillable at Committed 0 with no way to ever raise it, since
// Reallocate can only hand out on-hand stock that a Service item by definition never has.
//
// Matched case-insensitively on purpose: live data carries 'INVENTORY', 'JIT', 'Service'
// and '' in this column, so casing is clearly not something the source system normalizes.
const NON_STOCK_ITEM_TYPES = new Set(['service', 'non-inventory', 'noninventory']);

function isNonStockItem(itemType) {
  return NON_STOCK_ITEM_TYPES.has(String(itemType || '').trim().toLowerCase());
}

module.exports = { NON_STOCK_ITEM_TYPES, isNonStockItem };
