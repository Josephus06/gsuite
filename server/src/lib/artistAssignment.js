const pool = require('../db');

// "May this user hand layout work to an artist?" -- a grantable right of its own rather than a
// side effect of the is_design_supervisor flag.
//
// It used to be that flag, with can_edit on /job-orders as a fallback for admins. Neither could
// express what the design team actually needed:
//
//   * flagging someone is_design_supervisor to let them assign ALSO scopes their whole Job Orders
//     list down to the design queue (lib/designSupervisorVisibility.js), so a planner or manager
//     who just needed to unstick an assignment lost sight of every other job order;
//   * can_edit on /job-orders is the right to change the description, the dates, the materials --
//     far more than "pick who draws this", and the generic edit form deliberately refused the
//     artist field anyway, so the two gates disagreed about the same act.
//
// Now it is one row in the permission grid ("JO Assign Artist" > Can Update) that means exactly
// this and nothing else. It is checked fresh against the DB on every call rather than trusted off
// the JWT, same discipline as getSalesRepEmployeeScope -- a right withdrawn takes effect on the
// user's next request, not at their next login.
//
// The page has no screen of its own, so only can_edit carries meaning on it; see
// db/add-assign-artist-page.js, which registers the row and carries every existing grant across.
const ASSIGN_ARTIST_ROUTE = '/job-orders/assign-artist';
const JOB_ORDERS_ROUTE = '/job-orders';

async function canEditPage(userId, route) {
  const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
  if (!page) return null;
  const [[perm]] = await pool.query(
    'SELECT can_edit AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?',
    [userId, page.id],
  );
  return !!perm?.allowed;
}

// DESIGN SUPERVISORS ONLY (asked 2026-10-08). Assigning or reassigning the artist is the design
// supervisor's call and nobody else's: the "JO Assign Artist" grant above had spread to Production
// and Sales accounts (Velbeth could reassign the artist on JO-72206-1-3), so it is no longer
// consulted -- nor is System Admin, nor can_edit on Job Orders. canEditPage and the routes stay
// exported for anything still reading the grant row.
async function mayAssignArtist(userId) {
  const [[user]] = await pool.query(
    'SELECT is_design_supervisor FROM users WHERE id = ? AND is_active = 1', [userId],
  );
  return !!user?.is_design_supervisor;
}

module.exports = { mayAssignArtist, ASSIGN_ARTIST_ROUTE, JOB_ORDERS_ROUTE, canEditPage };
