const pool = require('../db');

// Who may NOTE a form -- the middle step of the Forms approval chain.
//
// A liquidation or a request for payment is noted by the HEAD OF THE DEPARTMENT IT CAME FROM, and
// the heads are the people already listed as that department's TICKET APPROVERS (Master Lists >
// Departments > Ticket Approvers). Per the team those are the same people, so they are kept in one
// place rather than maintained twice and allowed to disagree.
//
// NOT departments.head_user_id. That field is on the same screen -- "Department Head" -- but it is
// separately maintained and in the live data it names somebody different for several departments.
// The ticket approver list is the one the team pointed at, and a department can have SEVERAL, which
// the single head_user_id column cannot express: Sales - 1 lists both Arlene Arimbay and Michelle
// Riveral, and either of them noting is the intended behaviour.
//
// Read fresh on every request rather than trusted off the JWT -- the same discipline
// ticketVisibility.js uses, and for the same reason: an approver list changes after a token is
// issued, and a stale token must not carry authority somebody has since been removed from.

// The two forms whose noting is a departmental act. A business trip and a revolving fund keep the
// plain permission gate (can_edit on /forms/approval): they are not an expense claim against one
// department's budget, so there is no departmental head whose sign-off they need.
const DEPARTMENT_NOTED_TYPES = ['liquidation', 'payment'];

// Does this user head the given department -- i.e. are they one of its ticket approvers?
async function isDepartmentNoter(userId, departmentId, q = pool) {
  if (!departmentId) return false;
  const [[row]] = await q.query(
    'SELECT 1 AS ok FROM department_ticket_approvers WHERE department_id = ? AND user_id = ? LIMIT 1',
    [departmentId, userId],
  );
  return !!row;
}

// Every department this user heads. Used to widen the approval queue: a head has to be able to
// find the forms waiting on them without also being granted the whole approval page.
async function departmentsHeadedBy(userId, q = pool) {
  const [rows] = await q.query(
    `SELECT a.department_id FROM department_ticket_approvers a
       JOIN departments d ON d.id = a.department_id
      WHERE a.user_id = ? AND d.is_active = TRUE`,
    [userId],
  );
  return rows.map((r) => r.department_id);
}

// Who the form is waiting on, in words -- so a form that nobody can note says WHY rather than
// simply showing no button. Most departments have no ticket approver recorded yet, and a silent
// dead end would read as the module being broken.
async function notersFor(departmentId, q = pool) {
  if (!departmentId) return [];
  const [rows] = await q.query(
    `SELECT u.id, u.display_name FROM department_ticket_approvers a
       JOIN users u ON u.id = a.user_id
      WHERE a.department_id = ? ORDER BY u.display_name`,
    [departmentId],
  );
  return rows;
}

module.exports = { DEPARTMENT_NOTED_TYPES, isDepartmentNoter, departmentsHeadedBy, notersFor };
