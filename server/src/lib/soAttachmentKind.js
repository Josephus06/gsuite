const pool = require('../db');

// Sales order attachments carry a document type (2026-11-04): 'PO' marks the customer's purchase
// order, which Pending Billing's "wt PO" column looks for. The column (and pending_billing_marks, the
// hand-ticked boxes) come from db/add-so-attachment-kind.js; until that has run here, everything reads
// as untyped / unticked instead of failing. Checked until found, then remembered.
const SO_ATTACHMENT_KINDS = ['PO', 'Other'];
let known = false;
async function hasSoAttachmentKind() {
  if (known) return true;
  const [[r]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_order_attachments' AND COLUMN_NAME = 'kind')
          + (SELECT COUNT(*) FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pending_billing_marks') AS n`);
  known = Number(r.n) === 2;
  return known;
}

module.exports = { SO_ATTACHMENT_KINDS, hasSoAttachmentKind };
