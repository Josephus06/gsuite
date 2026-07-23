const pool = require('../db');

// Artist-scoped visibility for Job Orders and Non-Standard Job Orders: an Artist only
// ever sees the work assigned to them, never the whole list.
//
// This exists because getSalesRepEmployeeScope returns null (unrestricted) for anyone who
// is neither an Account Officer nor a Supervisor -- which an Artist is not -- so without
// this they fell through every filter and saw every transaction in the module.
//
// Checked fresh against the DB rather than trusted off the JWT, same discipline as
// getSalesRepEmployeeScope and isScopedToDesignQueue -- these flags can change after the
// token was issued.
//
// Returns:
//   null   -> no artist rule applies (System Admin; a Design Supervisor, who is already
//             scoped to their design queue by designSupervisorVisibility; anyone who
//             isn't an Artist; or an account with no employee record to match against).
//   number -> the employee id whose assigned work this user may see.
async function getArtistEmployeeScope(userId) {
  const [[user]] = await pool.query(
    'SELECT account_type, employee_id, is_design_supervisor FROM users WHERE id = ?',
    [userId],
  );
  if (!user || !user.employee_id) return null;
  if (user.account_type === 'System Admin') return null;
  // A Design Supervisor is an Artist account too, but their own queue rule governs them.
  if (user.is_design_supervisor) return null;
  if (user.account_type !== 'Artist') return null;
  return user.employee_id;
}

module.exports = { getArtistEmployeeScope };
