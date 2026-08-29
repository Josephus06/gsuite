const pool = require('../db');

// Who may act on a job order Production has handed back to Sales ("For Revision").
//
// Both actions that stage exists for -- correcting the delivery date and returning the job to
// Production -- belong to Sales. They were gated on can_edit for /job-orders, which is wrong in
// both directions at once. Too narrow, because almost no sales account holds it: of 27 sales
// users, 24 sit on can_view, so the revision landed in their queue with no way out of it and an
// admin as the only way to clear it. And too wide, because can_edit on /job-orders is not a
// sales permission -- three Production accounts hold it, so the people who RAISED the revision
// were being offered the button that ends it.
//
// So the rule is stated in terms of who these actions belong to rather than in terms of a
// permission that happens to correlate with it:
//
//   System Admin              -- always, as everywhere else in the app
//   the job order's sales rep -- their own job order, no further rights needed. This is the
//                                path that matters: it is what the revision loop is for.
//   any other Sales account   -- needs can_edit on /job-orders, i.e. a sales user trusted to
//                                edit job orders generally, covering for a colleague
//
// Everyone else is refused, Production included, whatever permissions they hold. Mirrored on the
// client by utils/salesRevision.js, which draws the buttons.
//
// `jo` only has to carry sales_rep_id.
const SALES_ACCOUNT_TYPE = 'Sales';

async function maySalesReviseJobOrder(userId, jo) {
  const [[me]] = await pool.query('SELECT account_type, employee_id FROM users WHERE id = ?', [userId]);
  if (!me) return false;
  if (me.account_type === 'System Admin') return true;
  // The rep named on the job order. Checked before the account type deliberately: whoever the
  // job order says owns it is the person the revision came back to.
  if (me.employee_id && String(jo?.sales_rep_id) === String(me.employee_id)) return true;
  if (me.account_type !== SALES_ACCOUNT_TYPE) return false;

  const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', ['/job-orders']);
  const [[perm]] = await pool.query(
    'SELECT can_edit AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?',
    [userId, page?.id]
  );
  return !!perm?.allowed;
}

module.exports = { maySalesReviseJobOrder, SALES_ACCOUNT_TYPE };
