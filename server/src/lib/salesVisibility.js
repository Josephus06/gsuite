const pool = require('../db');
const { isHeadOfficeName } = require('./userLocation');

// Sales-rep-scoped visibility for Estimates/Sales Orders: an Account Officer only ever
// sees their own transactions; a Supervisor sees their own plus everyone who reports to
// them (user_supervisors, one level -- "his or her people"), matching the
// account_type/is_account_officer/is_supervisor fields already on `users`. A rep with two
// supervisors is visible to both.
// Checked fresh against the DB on every call rather than trusted off the JWT, same
// discipline as the estimate-approval permission check -- these flags can change after
// the token was issued.
//
// Returns:
//   null                -> unrestricted (System Admin, or a role that's neither an
//                           Account Officer nor a Supervisor -- no visibility rule
//                           applies to them, so don't touch behavior for those accounts).
//   number[]             -> the employee ids whose transactions this user may see
//                           (their own, plus direct reports' if they're a supervisor),
//                           OR -- outside Head Office -- every branch person's.
//
// OUTSIDE HEAD OFFICE THE RULE IS THE BRANCHES, NOT THE PERSON. A user whose default login
// location is not Head Office sees every non-Head-Office person's transactions, not just their
// own: the branches work one another's jobs, cover for each other and answer the same walk-in
// customers, so scoping a branch account to its own name left the person standing in the shop
// unable to open the transaction the customer was asking about. What they still do not see is
// Head Office's own work. Permissions decide what they may DO with what they can see -- this
// answers only which rows exist for them, and an action they hold the right for works on a
// branch transaction whether or not it is theirs.
//
// NOT THE OFFICE LOCATION STAMPED ON THE DOCUMENT. That column says Head Office on all but a
// handful of rows -- all 29,081 estimates belonging to the seven branch accounts included --
// so reading the rule off the stamp would hide a branch user's OWN work from them. Whose
// transaction it is, is the sales rep behind it, and where THAT person logs in is the answer.
//
// It only ever widens. Anyone unrestricted today stays unrestricted (the early returns below
// come first), and the branch pool is unioned with the old own-plus-reports set rather than
// replacing it -- a branch supervisor with a Head Office report keeps seeing that report's
// work, which a straight replacement would quietly have taken away. Every one of the six
// reports on file is a branch user today, so the union is a no-op now; it is there so the
// first cross-location report does not silently narrow somebody's list.
async function getSalesRepEmployeeScope(userId) {
  const [[user]] = await pool.query(
    'SELECT account_type, is_account_officer, is_supervisor, employee_id FROM users WHERE id = ?',
    [userId]
  );
  if (!user || !user.employee_id) return null;
  if (user.account_type === 'System Admin') return null;
  if (!user.is_account_officer && !user.is_supervisor) return null;

  const ids = [user.employee_id];

  // Everyone's home location in one pass, rather than a query per user. The COALESCE is the same
  // one resolveDefaultLocation uses -- the Default Login Location wins, the older Default Branch
  // field is the fallback -- so this classifies each user exactly as isHeadOfficeUser would.
  //
  // Read fresh, like everything else here: moving someone's default login location has to take
  // effect on their next request, not at their next login.
  const [people] = await pool.query(
    `SELECT u.id, u.employee_id,
            COALESCE(
              (SELECT l.location_name FROM user_branches ub JOIN locations l ON l.id = ub.location_id
                WHERE ub.user_id = u.id AND ub.is_default = TRUE LIMIT 1),
              (SELECT l.location_name FROM locations l WHERE l.id = u.default_branch_id)
            ) AS location_name
       FROM users u`
  );
  // Judged in JS by isHeadOfficeName rather than by a LIKE in the SQL, so "is this Head Office"
  // has exactly one definition. A second copy in a WHERE clause is the kind that drifts.
  const atHeadOffice = (row) => isHeadOfficeName(row?.location_name);

  if (!atHeadOffice(people.find((r) => Number(r.id) === Number(userId)))) {
    people.filter((r) => r.employee_id && !atHeadOffice(r)).forEach((r) => ids.push(r.employee_id));
  }

  if (user.is_supervisor) {
    // Read from user_supervisors, not users.supervisor_id: a rep may report to several
    // supervisors, and the column only holds the primary -- using it would hide every
    // secondary report's transactions from the supervisor who also owns them.
    const [reports] = await pool.query(
      `SELECT DISTINCT e.id
         FROM user_supervisors us
         JOIN users u ON u.id = us.user_id
         JOIN employees e ON e.id = u.employee_id
        WHERE us.supervisor_id = ?`,
      [userId]
    );
    reports.forEach((r) => ids.push(r.id));
  }
  // Deduped because the three sources overlap -- a branch supervisor is in the pool, and so are
  // their branch reports.
  return [...new Set(ids)];
}

module.exports = { getSalesRepEmployeeScope };
