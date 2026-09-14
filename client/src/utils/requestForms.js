// Shared vocabulary for the Forms module -- the four request forms ported from the Booking system.
//
// Kept out of the page files because five screens read it (list, approval queue, view, edit,
// print), and a label that disagrees between the queue and the printed sheet is exactly the sort
// of drift that makes two people think they are looking at different documents.

export const TYPE_LABELS = {
  liquidation: 'Liquidation',
  payment: 'Request for Payment',
  business_trip: 'Business Trip',
  revolving_fund: 'Revolving Fund',
};

// Draft is grey because nothing has happened to it yet; rejected is the only status that asks the
// owner to act, so it is the loudest.
export const STATUS_BADGE = {
  draft: 'badge-muted',
  submitted: 'badge-warning',
  noted: 'badge-info',
  approved: 'badge-success',
  rejected: 'badge-danger',
};

// The six purposes printed on the liquidation form. 'others' is the one carrying free text.
export const PURPOSE_LABELS = {
  business_travel_allowance: 'Business Travel Allowance',
  mobilization_installation: 'Mobilization / Installation',
  site_inspection: 'Site Inspection',
  representation: 'Representation',
  employees_benefit: 'Employees Benefit',
  others: 'Others',
};

// The two forms that are a list of expenses against a cash advance.
export const FUND_TYPES = ['liquidation', 'revolving_fund'];

export function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

export function fmtDate(v) { return v ? String(v).slice(0, 10) : ''; }

export const pretty = (s) => (s ? String(s).replace(/_/g, ' ') : '');
