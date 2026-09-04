// Mirror of server/src/lib/jobOrderRevision.js -- see there for why the rules are what they are.
// Kept in step with it: this decides whether the controls are drawn, that decides whether the
// request is accepted, and a button the server will refuse is worse than no button at all.

export const REVISION_MATERIAL_PROCESS = 'material_process';
export const REVISION_DELIVERY_DATE = 'delivery_date';

export const REVISION_REASON_LABELS = {
  [REVISION_MATERIAL_PROCESS]: 'Change material / process',
  [REVISION_DELIVERY_DATE]: 'Change delivery date',
};

// WHY the promised delivery date cannot be met. Required on a date revision -- the free-text
// remark was the only place a cause was ever recorded and it was optional, so most date
// revisions reached Sales with a new date and nothing saying why.
//
// Order is the order of the dropdown. The KEYS are what is stored and what the server
// validates against (DATE_CHANGE_REASONS in server/src/lib/jobOrderRevision.js) -- keep the
// two lists in step, or the dropdown offers a value the endpoint then refuses.
export const DATE_CHANGE_REASON_LABELS = {
  lack_of_material: 'Lack of material',
  machine_maintenance: 'Machine maintenance',
  volume_exceeds_lead_time: 'The volume does not meet production lead time',
  power_interruption: 'Power interruption',
  change_material: 'Change material',
  additional_process: 'Additional process',
  shortage_of_consumables: 'Shortage of consumables',
};
export const DATE_CHANGE_REASONS = Object.keys(DATE_CHANGE_REASON_LABELS);

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
