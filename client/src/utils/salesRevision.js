// Mirror of server/src/lib/jobOrderRevision.js -- see there for why the rules are what they are.
// Kept in step with it: this decides whether the controls are drawn, that decides whether the
// request is accepted, and a button the server will refuse is worse than no button at all.

export const REVISION_MATERIAL_PROCESS = 'material_process';
export const REVISION_DELIVERY_DATE = 'delivery_date';

export const REVISION_REASON_LABELS = {
  [REVISION_MATERIAL_PROCESS]: 'Change material / process',
  [REVISION_DELIVERY_DATE]: 'Change delivery date',
};

// `canEditJobOrders` is the caller's can('/job-orders', 'can_edit').
export function maySalesRevise(user, jo, canEditJobOrders) {
  if (!user) return false;
  if (user.account_type === 'System Admin') return true;
  if (user.employee_id && String(jo?.sales_rep_id) === String(user.employee_id)) return true;
  return user.account_type === 'Sales' && !!canEditJobOrders;
}

// The narrow edit right a "change material/process" revision carries: this job order, this rep,
// for as long as it is in revision for that reason. Anyone with can_edit already has more.
export function mayReworkJobOrder(user, jo) {
  if (!user || !jo) return false;
  if (jo.production_stage !== 'for_revision' || jo.revision_reason !== REVISION_MATERIAL_PROCESS) return false;
  if (jo.status === 'Cancelled') return false;
  return !!user.employee_id && String(jo.sales_rep_id) === String(user.employee_id);
}

// Is Sales still being asked to answer a suggested delivery date?
export function awaitingDateDecision(jo) {
  return jo?.production_stage === 'for_revision'
    && jo?.revision_reason === REVISION_DELIVERY_DATE
    && !jo?.revision_date_decision
    && jo?.status !== 'Cancelled';
}
