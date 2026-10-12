// What has already posted a Liquidation (Forms) to the books. The form itself posts nothing
// (lib/glImpact.js); it is posted by Vendor Bills (vendor_bills.form_request_id) OR by one Journal
// (journals.form_request_id). A cancelled bill or a voided journal frees what it posted.
//
// Since 2026-10-12 a liquidation can be split across several Vendor Bills BY ITEM -- receipts from
// different vendors -- each item on exactly one bill (vendor_bill_form_items). Once any bill exists
// the rest goes on bills too: a Journal is only for a liquidation nothing has posted yet. A bill
// raised before the split existed has no item rows and is read as posting every item, as it did.

async function liquidationBilling(conn, formId) {
  const [bills] = await conn.query(
    "SELECT id, bill_no FROM vendor_bills WHERE form_request_id = ? AND status <> 'cancelled' ORDER BY id", [formId]);
  const [[journal]] = await conn.query(
    "SELECT id, journal_no FROM journals WHERE form_request_id = ? AND status <> 'void' ORDER BY id DESC LIMIT 1", [formId]);
  // Items with an amount -- the ones Create Vendor Bill copies; a zero line has nothing to post.
  const [items] = await conn.query(
    'SELECT id FROM form_request_items WHERE form_request_id = ? AND amount <> 0', [formId]);
  const itemIds = items.map((i) => Number(i.id));
  const billOfItem = new Map(); // item id -> bill_no
  if (bills.length) {
    const [links] = await conn.query(
      'SELECT vendor_bill_id, form_request_item_id FROM vendor_bill_form_items WHERE vendor_bill_id IN (?)', [bills.map((b) => b.id)]);
    const linked = new Set(links.map((l) => Number(l.vendor_bill_id)));
    const noById = new Map(bills.map((b) => [Number(b.id), b.bill_no]));
    for (const l of links) billOfItem.set(Number(l.form_request_item_id), noById.get(Number(l.vendor_bill_id)));
    // An older bill with no item rows posted the whole liquidation.
    const legacy = bills.find((b) => !linked.has(Number(b.id)));
    if (legacy) itemIds.forEach((id) => { if (!billOfItem.has(id)) billOfItem.set(id, legacy.bill_no); });
  }
  const unbilledItemIds = itemIds.filter((id) => !billOfItem.has(id));
  return {
    bills, journal: journal || null, itemIds, billOfItem, unbilledItemIds,
    fullyPosted: !!journal || (bills.length > 0 && unbilledItemIds.length === 0),
  };
}

// Kept for callers that only want "is it posted, and by what": the latest bill and the journal.
async function liquidationPostedBy(conn, formId) {
  const b = await liquidationBilling(conn, formId);
  return { bill: b.bills[b.bills.length - 1] || null, journal: b.journal };
}

// Refuses (returns the reason) unless formId is an approved liquidation that may be posted this way.
//   via 'journal' (default): nothing has posted it yet.
//   via 'bill', itemIds: no Journal posted it, and every item named is its own and not on a live bill.
async function liquidationPostError(conn, formId, { via = 'journal', itemIds = null } = {}) {
  const [[form]] = await conn.query('SELECT type, status, request_no FROM form_requests WHERE id = ?', [formId]);
  if (!form || form.type !== 'liquidation') return 'That form is not a liquidation.';
  if (form.status !== 'approved') return `${form.request_no} is not approved yet.`;
  const b = await liquidationBilling(conn, formId);
  if (b.journal) return `${form.request_no} is already posted on ${b.journal.journal_no}.`;
  if (via !== 'bill') {
    if (b.bills.length) return `${form.request_no} is already billed on ${b.bills.map((x) => x.bill_no).join(', ')}; the rest of it goes on Vendor Bills too.`;
    return null;
  }
  if (!b.unbilledItemIds.length) return `Every item of ${form.request_no} is already billed (${b.bills.map((x) => x.bill_no).join(', ')}).`;
  const ids = (itemIds || []).map(Number).filter(Boolean);
  if (!ids.length) return `Keep at least one of ${form.request_no}'s items on this bill.`;
  for (const id of ids) {
    if (!b.itemIds.includes(id)) return `An item on this bill is not one of ${form.request_no}'s.`;
    if (b.billOfItem.has(id)) return `An item on this bill is already billed on ${b.billOfItem.get(id)}.`;
  }
  return null;
}

module.exports = { liquidationBilling, liquidationPostedBy, liquidationPostError };
