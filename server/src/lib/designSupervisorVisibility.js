const pool = require('../db');

// Design-Supervisor-scoped visibility for Job Orders: a Design Supervisor only ever
// sees JOs actively in the design queue they're responsible for -- status "Planned -
// Pending for BOM" with sub_status "For Design Supervisor" (their own queue to assign
// an artist) or "For Artist" (already assigned, still in layout) -- not the full JO
// list. Checked fresh against the DB rather than trusted off the JWT, same discipline
// as getSalesRepEmployeeScope in salesVisibility.js.
//
// Returns:
//   false -> unrestricted (System Admin, or anyone who isn't a Design Supervisor --
//            no visibility rule applies to them, so don't touch behavior for those
//            accounts).
//   true  -> caller should add the DESIGN_QUEUE_STATUS/DESIGN_QUEUE_SUB_STATUSES filter.
//
// A SALES ACCOUNT KEEPS ITS SALES VIEW (asked 2026-10-09). A branch supervisor assigns the artist
// on her own people's jobs, so she carries the Design Supervisor flag (mayAssignArtist reads
// nothing else) -- and the queue rule then hid every one of her team's job orders that wasn't in
// layout: Cindy Deniay_SM could not open Dexter Bantilan's JO-196331-1-1 at Sales Approval. Anyone
// flagged Account Officer, Supervisor or SBU is already scoped by whose job it is
// (lib/salesVisibility.js), which covers their team's design-queue orders too, so the queue rule
// stands aside for them rather than stacking on top.
const DESIGN_QUEUE_STATUS = 'Planned - Pending for BOM';
const DESIGN_QUEUE_SUB_STATUSES = ['For Design Supervisor', 'For Artist', 'For Artist (Revision)'];

async function isScopedToDesignQueue(userId) {
  const [[user]] = await pool.query(
    `SELECT account_type, is_design_supervisor, is_account_officer, is_supervisor, is_sales_business_unit
       FROM users WHERE id = ?`,
    [userId]
  );
  if (!user) return false;
  if (user.account_type === 'System Admin') return false;
  if (user.is_account_officer || user.is_supervisor || user.is_sales_business_unit) return false;
  return !!user.is_design_supervisor;
}

module.exports = { isScopedToDesignQueue, DESIGN_QUEUE_STATUS, DESIGN_QUEUE_SUB_STATUSES };
