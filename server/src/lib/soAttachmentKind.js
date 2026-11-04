const pool = require('../db');

// Sales order attachments carry a document type (2026-11-04): 'PO' marks the customer's purchase
// order, which Pending Billing's "wt PO" column looks for. The column comes from
// db/add-so-attachment-kind.js; until that has run here, everything reads as untyped instead of
// failing. Checked once and remembered once it exists.
const SO_ATTACHMENT_KINDS = ['PO', 'Other'];
let known = false;
async function hasSoAttachmentKind() {
  if (known) return true;
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_order_attachments' AND COLUMN_NAME = 'kind'`);
  known = r.n > 0;
  return known;
}

module.exports = { SO_ATTACHMENT_KINDS, hasSoAttachmentKind };
