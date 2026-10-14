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
  overtime: 'Overtime Request',
  leave: 'Leave Application',
  gate_pass: 'Employee Gate Pass',
};

// Which forms are HR's (2026-10-13) -- the form picker shows them as their own group.
export const HR_TYPES = ['leave', 'overtime', 'attendance_adjustment', 'gate_pass'];

// Forms with no expense lines (and so no amount): a trip sheet, and the attendance adjustment slip.
export const NO_ITEM_TYPES = ['business_trip', 'attendance_adjustment', 'overtime', 'leave', 'gate_pass'];

// Leave Application (2026-10-13). The server counts the same days (routes/forms.js leaveDays).
export const LEAVE_TYPE_LABELS = {
  sick: 'Sick Leave',
  vacation: 'Vacation Leave',
  emergency: 'Emergency Leave',
  maternity: 'Maternity Leave',
  paternity: 'Paternity Leave',
  bereavement: 'Bereavement Leave',
  birthday: 'Birthday Leave',
  solo_parent: 'Solo Parent Leave',
  without_pay: 'Leave Without Pay',
  others: 'Others',
};
export const DAY_PART_LABELS = { whole: 'Whole day', am: 'Half day (AM)', pm: 'Half day (PM)' };
// Every day from..to except Sundays; a half day (one date only) is 0.5.
export function leaveDays(from, to, part) {
  const end = to || from;
  if (!from || end < from) return 0;
  if (from === end && part && part !== 'whole') return 0.5;
  let n = 0;
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0) n += 1;
  }
  return n;
}
export const leaveTypeLabel = (d) => (d?.leave_type === 'others' && d.leave_type_other
  ? d.leave_type_other : LEAVE_TYPE_LABELS[d?.leave_type] || d?.leave_type || '');

// Overtime Request (2026-10-13): hours between two "HH:MM" times; past midnight counts on.
export function overtimeHours(from, to) {
  if (!from || !to) return null;
  const m = (t) => { const [h, mi] = String(t).slice(0, 5).split(':').map(Number); return h * 60 + mi; };
  let span = m(to) - m(from);
  if (span <= 0) span += 24 * 60;
  return Math.round((span / 60) * 100) / 100;
}

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
  accepted: 'badge-success',
  declined: 'badge-danger',
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

// Fund Transfer (2026-10-14): every bank a form's lines move money From (side 'from') or To ('to'),
// each once, in line order -- printed in place of "Several". Falls back to the form's own pair.
export function formBanks(doc, side) {
  const d = doc?.detail || {};
  const seen = new Set();
  const labels = [];
  for (const r of doc?.items || []) {
    const label = bankLabel(r[`${side}_account_code`], r[`${side}_account_name`]);
    if (label && !seen.has(label)) { seen.add(label); labels.push(label); }
  }
  return labels.length ? labels.join(' / ') : bankLabel(d[`${side}_account_code`], d[`${side}_account_name`]);
}
