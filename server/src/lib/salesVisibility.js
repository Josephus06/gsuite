const pool = require('../db');

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
//                           (their own, plus direct reports' if they're a supervisor).
async function getSalesRepEmployeeScope(userId) {
  const [[user]] = await pool.query(
    'SELECT account_type, is_account_officer, is_supervisor, employee_id FROM users WHERE id = ?',
    [userId]
  );
  if (!user || !user.employee_id) return null;
  if (user.account_type === 'System Admin') return null;
  if (!user.is_account_officer && !user.is_supervisor) return null;

  const ids = [user.employee_id];
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
  return ids;
}

module.exports = { getSalesRepEmployeeScope };
