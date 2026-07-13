const pool = require('../db');

// Sales-rep-scoped visibility for Estimates/Sales Orders: an Account Officer only ever
// sees their own transactions; a Supervisor sees their own plus everyone who reports to
// them (users.supervisor_id -> users.id, one level -- "his or her people"), matching the
// account_type/is_account_officer/is_supervisor/supervisor_id fields already on `users`.
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
    const [reports] = await pool.query(
      `SELECT e.id FROM users u JOIN employees e ON e.id = u.employee_id WHERE u.supervisor_id = ?`,
      [userId]
    );
    reports.forEach((r) => ids.push(r.id));
  }
  return ids;
}

module.exports = { getSalesRepEmployeeScope };
