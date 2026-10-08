const pool = require('../db');

// Who may NOTE a form -- the middle step of the Forms approval chain.
//
// A liquidation or a request for payment is noted by the HEAD OF THE DEPARTMENT IT CAME FROM, and
// the heads are the people listed as that department's approvers (Master Lists > Departments), with
// "Can note a request form" ticked. One list of heads, two jobs, ticked per person:
//
//   can_approve_ticket   signs off tickets raised by this department
//   can_note_form        notes this department's liquidations and payments   <- what this file reads
//
// The two are separate because naming somebody as a ticket approver should not silently hand them
// authority over the department's expense claims. Every query here filters on can_note_form, so a
// name on the list with that box unticked is not a noter however the rest of the row reads.
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
//
// A LIQUIDATION is no longer one of them (asked 2026-10-06): Accounts Payable notes every
// liquidation, whatever department it came from, once it has given each item the COGS account it is
// charged to -- see AP_NOTED_TYPES below and the Accounts Payable tick on the user.
// A Fund Transfer Request Form is a Request for Payment with banks named, so it is noted the same way.
// An attendance adjustment is noted by the immediate superior -- the department's head (2026-10-08).
const DEPARTMENT_NOTED_TYPES = ['payment', 'fund_transfer', 'attendance_adjustment'];
const AP_NOTED_TYPES = ['liquidation'];

// Is this user Accounts Payable (users.is_accounts_payable)? Read fresh, like the rest of this file.
async function isAccountsPayable(userId, q = pool) {
  const [[row]] = await q.query('SELECT is_accounts_payable FROM users WHERE id = ? AND is_active = 1', [userId]);
  return !!(row && row.is_accounts_payable);
}

async function accountsPayableUsers(q = pool) {
  const [rows] = await q.query('SELECT id, display_name FROM users WHERE is_accounts_payable = 1 AND is_active = 1 ORDER BY display_name');
  return rows;
}

// Does this user head the given department -- i.e. are they one of its ticket approvers?
async function isDepartmentNoter(userId, departmentId, q = pool) {
  if (!departmentId) return false;
  const [[row]] = await q.query(
    'SELECT 1 AS ok FROM department_ticket_approvers WHERE department_id = ? AND user_id = ? AND can_note_form = 1 LIMIT 1',
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
      WHERE a.user_id = ? AND a.can_note_form = 1 AND d.is_active = TRUE`,
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
      WHERE a.department_id = ? AND a.can_note_form = 1 ORDER BY u.display_name`,
    [departmentId],
  );
  return rows;
}

// Who a given form is waiting on to be noted: AP for a liquidation, the department's heads for a
// payment, nobody named for the rest (they go by permission).
async function notersForDoc(doc, q = pool) {
  if (AP_NOTED_TYPES.includes(doc.type)) return accountsPayableUsers(q);
  if (DEPARTMENT_NOTED_TYPES.includes(doc.type)) return notersFor(doc.department_id, q);
  return [];
}

module.exports = {
  DEPARTMENT_NOTED_TYPES, AP_NOTED_TYPES, isDepartmentNoter, departmentsHeadedBy, notersFor,
  isAccountsPayable, accountsPayableUsers, notersForDoc,
};
