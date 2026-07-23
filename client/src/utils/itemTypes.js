// Mirrors server/src/lib/itemTypes.js -- keep the two in step. A Service item is a
// charge for work done, not a thing on a shelf, so it holds no stock anywhere: nothing
// to reallocate, nothing to commit, and no on-hand balance to draw down. The screens use
// this to drop the stock-only affordances (Reallocate, the "Not committed" block) rather
// than showing controls that can never do anything for such a line.
const NON_STOCK_ITEM_TYPES = ['service', 'non-inventory', 'noninventory'];

export function isNonStockItem(itemType) {
  return NON_STOCK_ITEM_TYPES.includes(String(itemType || '').trim().toLowerCase());
}
