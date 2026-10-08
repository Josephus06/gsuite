import { displayDate } from './dates';
// Shared vocabulary for the Forms module -- the four request forms ported from the Booking system.
//
// Kept out of the page files because five screens read it (list, approval queue, view, edit,
// print), and a label that disagrees between the queue and the printed sheet is exactly the sort
// of drift that makes two people think they are looking at different documents.

export const TYPE_LABELS = {
  liquidation: 'Liquidation',
  payment: 'Request for Payment',
  fund_transfer: 'Fund Transfer Request Form',
  business_trip: 'Business Trip',
  revolving_fund: 'Revolving Fund',
  attendance_adjustment: 'Attendance Adjustment Form',
};

// Forms with no expense lines (and so no amount): a trip sheet, and the attendance adjustment slip.
export const NO_ITEM_TYPES = ['business_trip', 'attendance_adjustment'];

// Attendance Adjustment Form (asked 2026-10-08): the times the biometric missed, and why.
export const ADJ_TIMES = [
  ['am_in', 'AM IN'], ['am_out', 'AM OUT'],
  ['pm_in', 'PM IN'], ['pm_out', 'PM OUT'],
  ['ot_in', 'OT IN'], ['ot_out', 'OT OUT'],
];
export const ADJ_REASON_LABELS = { field_work: 'Field Work', business_trip: 'Business Trip', others: 'Others' };
// "08:10" -> "8:10 AM", as people write it on the slip.
export function clock(v) {
  if (!v) return '';
  const [h, m] = String(v).slice(0, 5).split(':').map(Number);
  if (!Number.isFinite(h)) return String(v);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

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

// Request for Payment, and Fund Transfer Request Form -- the same form plus the From and To banks.
export const PAYMENT_TYPES = ['payment', 'fund_transfer'];

// A bank account as the From / To fields show it.
export const bankLabel = (code, name) => (name ? `${code ? `${code} — ` : ''}${name}` : '');

// The two forms that are a list of expenses against a cash advance.
export const FUND_TYPES = ['liquidation', 'revolving_fund'];

export function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

export function fmtDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

export const pretty = (s) => (s ? String(s).replace(/_/g, ' ') : '');
