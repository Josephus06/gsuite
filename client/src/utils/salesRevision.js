// Mirror of maySalesReviseJobOrder in server/src/lib/jobOrderRevision.js -- see there for why
// the rule is what it is. Kept in step with it: this decides whether the buttons are drawn,
// that decides whether the request is accepted, and a button the server will refuse is worse
// than no button at all.
//
// `canEditJobOrders` is the caller's can('/job-orders', 'can_edit').
export function maySalesRevise(user, jo, canEditJobOrders) {
  if (!user) return false;
  if (user.account_type === 'System Admin') return true;
  if (user.employee_id && String(jo?.sales_rep_id) === String(user.employee_id)) return true;
  return user.account_type === 'Sales' && !!canEditJobOrders;
}
