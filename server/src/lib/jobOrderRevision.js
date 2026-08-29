const pool = require('../db');

// Who may act on a job order Production has handed back to Sales ("For Revision").
//
// The two actions that stage exists for -- correcting the delivery date and returning the job
// to Production -- were gated on can_edit for /job-orders, which almost no Sales account holds:
// of 27 sales users, 24 sit on can_view. So the revision landed in their queue with no way out
// of it, and only an admin could see the button that returns it. The rep who owns the job order
// can now do both without broader edit rights over Job Orders in general -- the same dual-check
// shape as forward-to-design and sales-approval, which already work this way for the same
// reason. can_edit still passes, so admins and managers are unaffected.
//
// `jo` only has to carry sales_rep_id.
async function maySalesReviseJobOrder(userId, jo) {
  const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [userId]);
  if (me?.employee_id && String(jo?.sales_rep_id) === String(me.employee_id)) return true;
  const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', ['/job-orders']);
  const [[perm]] = await pool.query(
    'SELECT can_edit AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?',
    [userId, page?.id]
  );
  return !!perm?.allowed;
}

module.exports = { maySalesReviseJobOrder };
