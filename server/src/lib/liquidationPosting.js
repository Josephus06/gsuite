// What has already posted a Liquidation (Forms) to the books. One is posted by EITHER a Vendor Bill
// (vendor_bills.form_request_id) OR a Journal (journals.form_request_id), once -- the form itself
// posts nothing (lib/glImpact.js). A cancelled bill or a voided journal frees the form again.

async function liquidationPostedBy(conn, formId) {
  const [[bill]] = await conn.query(
    "SELECT id, bill_no FROM vendor_bills WHERE form_request_id = ? AND status <> 'cancelled' ORDER BY id DESC LIMIT 1", [formId]);
  const [[journal]] = await conn.query(
    "SELECT id, journal_no FROM journals WHERE form_request_id = ? AND status <> 'void' ORDER BY id DESC LIMIT 1", [formId]);
  return { bill: bill || null, journal: journal || null };
}

// Refuses (returns the reason) unless formId is an approved liquidation nothing has posted yet.
async function liquidationPostError(conn, formId) {
  const [[form]] = await conn.query('SELECT type, status, request_no FROM form_requests WHERE id = ?', [formId]);
  if (!form || form.type !== 'liquidation') return 'That form is not a liquidation.';
  if (form.status !== 'approved') return `${form.request_no} is not approved yet.`;
  const { bill, journal } = await liquidationPostedBy(conn, formId);
  if (bill) return `${form.request_no} is already posted on ${bill.bill_no}.`;
  if (journal) return `${form.request_no} is already posted on ${journal.journal_no}.`;
  return null;
}

module.exports = { liquidationPostedBy, liquidationPostError };
