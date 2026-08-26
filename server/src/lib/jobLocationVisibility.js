const pool = require('../db');

// Department-scoped visibility for Job Orders: someone filed under a production department
// only ever sees the job orders sitting in that department's warehouse. A user in
// "Production-SIGNAGE" sees "Warehouse - Sign" work and nothing else -- not LFP's, not DPOD's,
// not CNC's.
//
// Which warehouse belongs to which department is data, not code: departments.job_location_id,
// editable at Lookups > Departments > Job Location Restriction (see
// db/add-department-job-location.js). A department that leaves it empty is unrestricted, which
// is every non-production department -- Sales, Accounting, Design, Support -- so this rule
// costs them nothing.
//
// "The user's department" means the department on their default branch (user_branches with
// is_default = TRUE, the "Default Login Location" row on the User Branches wizard step). That is
// already what the rest of the app means by it -- GET /auth/me returns it as
// user.default_branch.department_name, and it is what auto-fills a new Estimate's branch -- so a
// user with several branch rows gets one predictable answer rather than a union that would
// quietly widen the restriction.
//
// Checked fresh against the DB rather than trusted off the JWT, same discipline as
// getArtistEmployeeScope and isScopedToDesignQueue -- a transfer between departments has to take
// effect on the user's next request, not at their next login.
//
// Returns:
//   null   -> unrestricted (System Admin; a user with no default branch; or a department with no
//             job location mapped). Callers must not filter at all in this case.
//   number -> the locations.id whose job orders this user may see.
async function getJobLocationScope(userId) {
  const [[user]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  if (user.account_type === 'System Admin') return null;

  const [[branch]] = await pool.query(
    `SELECT d.job_location_id
       FROM user_branches ub
       JOIN departments d ON d.id = ub.department_id
      WHERE ub.user_id = ? AND ub.is_default = TRUE
      LIMIT 1`,
    [userId]
  );
  return branch?.job_location_id || null;
}

// Guard for the detail endpoints behind those lists. Hiding a job order from the list while
// still serving it to anyone who types its id is not a restriction, so every "open one" route
// re-checks -- and answers 404 rather than 403, so an out-of-department job order reads as one
// that isn't there rather than one worth going looking for.
//
// `row` is whatever the route already fetched; it only has to carry job_location_id.
function isJobLocationVisible(row, scopeLocationId) {
  if (!scopeLocationId) return true;
  return Number(row?.job_location_id) === Number(scopeLocationId);
}

module.exports = { getJobLocationScope, isJobLocationVisible };
