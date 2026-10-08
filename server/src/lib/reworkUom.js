// A rework job order (RWIP / RFQC) sizes its material in the MOTHER job order's UOM (asked
// 2026-10-08). RWIP-1289 came out with its lines in SQFT where JO-193492-1-1 had them in MM, so
// 2475 x 980 was read as square feet and its Total became 2,425,500 instead of ~26 SQFT.
//
// For a line whose item is also on the mother, the mother's UOM for that item is the only one
// allowed. Returns that UOM, or null when there is no rule (not a rework JO, no item, or an item
// the mother does not use -- a genuinely new material on the rework).
async function motherUom(conn, jobOrderId, itemId) {
  if (!itemId) return null;
  const [[jo]] = await conn.query('SELECT parent_job_order_id FROM job_orders WHERE id = ?', [jobOrderId]);
  if (!jo?.parent_job_order_id) return null;
  return motherUomOf(conn, jo.parent_job_order_id, itemId);
}

async function motherUomOf(conn, motherId, itemId) {
  if (!motherId || !itemId) return null;
  const [[line]] = await conn.query(
    "SELECT uom FROM job_order_processes WHERE job_order_id = ? AND item_id = ? AND uom IS NOT NULL AND uom <> '' ORDER BY line_no LIMIT 1",
    [motherId, itemId]);
  return line ? line.uom : null;
}

module.exports = { motherUom, motherUomOf };
