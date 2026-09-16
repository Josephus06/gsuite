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

async function mayAssignArtist(userId) {
  const [[user]] = await pool.query(
    'SELECT account_type, is_design_supervisor FROM users WHERE id = ?', [userId],
  );
  if (!user) return false;
  // System Admin is full access by definition, and unlike requirePermission this does not depend
  // on the seeding having reached this row on this install.
  if (user.account_type === 'System Admin') return true;

  const granted = await canEditPage(userId, ASSIGN_ARTIST_ROUTE);
  if (granted !== null) return granted;

  // The page row is not registered on this install yet. requirePermission answers a missing row
  // with a 500 and that is what makes its deploy order so unforgiving -- push the code before the
  // registration script runs and every endpoint in the module dies. This is the same situation
  // read the other way: until the row exists, fall back to exactly the rule this replaced
  // (the flag, or generic can_edit on Job Orders), so the code may ship before the migration and
  // nobody is locked out in between. Once add-assign-artist-page.js has run, the grant above is
  // the only thing consulted and this branch never runs again.
  if (user.is_design_supervisor) return true;
  return (await canEditPage(userId, JOB_ORDERS_ROUTE)) === true;
}

module.exports = { mayAssignArtist, ASSIGN_ARTIST_ROUTE };
