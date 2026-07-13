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
const DESIGN_QUEUE_STATUS = 'Planned - Pending for BOM';
const DESIGN_QUEUE_SUB_STATUSES = ['For Design Supervisor', 'For Artist'];

async function isScopedToDesignQueue(userId) {
  const [[user]] = await pool.query('SELECT account_type, is_design_supervisor FROM users WHERE id = ?', [userId]);
  if (!user) return false;
  if (user.account_type === 'System Admin') return false;
  return !!user.is_design_supervisor;
}

module.exports = { isScopedToDesignQueue, DESIGN_QUEUE_STATUS, DESIGN_QUEUE_SUB_STATUSES };
