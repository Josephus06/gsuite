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
  undertime: 'Undertime Form',
  gate_pass: 'Employee Gate Pass',
  hmo_enrollment: 'Life & Health - Enrollment',
  hmo_deletion: 'Life & Health - Deletion',
  bpi_deletion: 'BPI Deletion',
  fuel: 'Fuel Request',
  office_supply: 'Office Supply Requisition Form',
  bank_loan: 'Request to Apply for a Bank Loan',
};

// Which forms are HR's (2026-10-13) -- the form picker shows them as their own group.
export const HR_TYPES = ['leave', 'undertime', 'overtime', 'attendance_adjustment', 'gate_pass', 'office_supply', 'hmo_enrollment', 'hmo_deletion', 'bpi_deletion'];

// Forms with no expense lines (and so no amount): a trip sheet, and the attendance adjustment slip.
export const NO_ITEM_TYPES = ['business_trip', 'attendance_adjustment', 'overtime', 'leave', 'undertime', 'gate_pass', 'hmo_enrollment', 'hmo_deletion', 'bpi_deletion', 'fuel', 'office_supply', 'bank_loan'];

// Request to Apply for a Bank Loan (2026-11-10), its rows in the order of the company's letter.
// money = an amount (PhP), date = a day; the rest are text. Kept in step with routes/forms.js.
export const BANK_LOAN_ROWS = [
  { key: 'loan_amount', field: 'bl_amount', label: 'Amount of Loan to be applied (in PhP)', type: 'money', required: true },
  { key: 'need_by_date', field: 'bl_need_by_date', label: 'Need by Date', type: 'date' },
  { key: 'purpose', field: 'bl_purpose', label: 'Purpose', required: true },
  { key: 'borrower', field: 'bl_borrower', label: 'Borrower' },
  { key: 'bank', field: 'bl_bank', label: 'Bank', required: true },
  { key: 'doc_stamp', field: 'bl_doc_stamp', label: 'Doc Stamp', type: 'money' },
  { key: 'advance_interest', field: 'bl_advance_interest', label: 'Advance Interest', type: 'money' },
  { key: 'net_proceeds', field: 'bl_net_proceeds', label: 'Net Proceeds', type: 'money' },
  { key: 'proceeds_instruction', field: 'bl_proceeds_instruction', label: 'Instruction for Net Proceeds' },
  { key: 'term_of_payment', field: 'bl_term_of_payment', label: 'Term of Payment' },
  { key: 'journal_entry_no', field: 'bl_journal_entry_no', label: 'JRNL Entry No.' },
  { key: 'pn_no', field: 'bl_pn_no', label: 'PN #' },
  { key: 'bank_notice', field: 'bl_bank_notice', label: 'Notice to Bank via Email/Viber' },
  { key: 'remarks', field: 'bl_remarks', label: 'Remarks', multiline: true },
];
// A row's value as printed: PhP1,500,000.00 for an amount, 10/21/2026 for a date.
export function bankLoanValue(row, d) {
  const v = d?.[row.key];
  if (v == null || v === '') return '';
  if (row.type === 'money') return `PhP${money(v)}`;
  if (row.type === 'date') return fmtDate(v);
  return String(v);
}

// HR's member lists (2026-10-19), after HR's own sheets -- kept in step with server/src/routes/forms.js
// MEMBER_FORMS. Each column: key, the sheet's heading, and how it is entered.
const PD = { type: 'select', options: [['P', 'P - Principal'], ['D', 'D - Dependent']] };
export const MEMBER_FORMS = {
  hmo_enrollment: {
    title: 'Life & Health - Enrollment', addLabel: 'Add Member',
    columns: [
      { key: 'member_type', label: 'P / D', ...PD, width: 120 },
      { key: 'family_name', label: 'Family Name' },
      { key: 'first_name', label: 'First Name' },
      { key: 'middle_initial', label: 'M.I.', width: 60 },
      { key: 'birthday', label: 'Birthday', type: 'date', width: 140 },
      { key: 'gender', label: 'Gender (M/F)', type: 'select', options: [['M', 'M'], ['F', 'F']], width: 80 },
      { key: 'civil_status', label: 'Single / Married', type: 'select', options: [['S', 'S'], ['M', 'M'], ['W', 'Widow']], width: 90 },
      { key: 'relationship', label: 'Relationship' },
      { key: 'position', label: 'Position' },
      { key: 'plan', label: 'Plan', placeholder: 'e.g. PAYWARD-30K MBL' },
      { key: 'remarks', label: 'Remarks', placeholder: 'e.g. WITH DENTAL' },
    ],
  },
  hmo_deletion: {
    title: 'Life & Health - Deletion', addLabel: 'Add Member',
    columns: [
      { key: 'member_type', label: 'Principal / Dependent', ...PD, width: 140 },
      { key: 'full_name', label: 'Name' },
      { key: 'company', label: 'Company', placeholder: 'Cebu Graphic Star Imaging Corp.' },
      { key: 'reason', label: 'Reason for the Removal', placeholder: 'e.g. Voluntary Resignation of member' },
    ],
  },
  bpi_deletion: {
    title: 'BPI Deletion', addLabel: 'Add Employee',
    columns: [
      { key: 'full_name', label: 'Name of Employee' },
      { key: 'bank_account_no', label: 'BPI Account Number' },
      { key: 'remarks', label: 'Remarks' },
    ],
  },
};
export const blankMemberLine = (type) => Object.fromEntries((MEMBER_FORMS[type]?.columns || []).map((c) => [c.key,
  c.key === 'company' && type === 'hmo_deletion' ? 'Cebu Graphic Star Imaging Corp.' : '']));

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

// Undertime Form (2026-10-20): minutes between the time out and the scheduled time out, same day.
export function undertimeMinutes(timeOut, shiftEnd) {
  if (!timeOut || !shiftEnd) return null;
  const m = (t) => { const [h, mi] = String(t).slice(0, 5).split(':').map(Number); return h * 60 + mi; };
  return m(shiftEnd) - m(timeOut);
}
// 90 -> "1 hr 30 min"
export function hoursMinutes(mins) {
  if (mins == null || !Number.isFinite(Number(mins))) return '';
  const n = Math.max(0, Number(mins)); const h = Math.floor(n / 60); const m = n % 60;
  return [h ? `${h} hr${h === 1 ? '' : 's'}` : '', m || !h ? `${m} min` : ''].filter(Boolean).join(' ');
}

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
  cancelled: 'badge-muted',
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
// A form's status as people read it (2026-10-22): submitted waits on the noter, noted on the approver.
export const statusLabel = (s) => ({ submitted: 'For Noting', noted: 'For Approval' }[s] || pretty(s));
// The secondary status of a form on a Vendor Bill (2026-11-12): "Released" once a Bill Payment of
// it has its Date Released, else "Not Released". Empty for a form with no Vendor Bill.
export const releaseLabel = (r) => ({ released: 'Released', not_released: 'Not Released' }[r] || '');
export const releaseBadge = (r) => (r === 'released' ? 'badge-success' : 'badge-warning');

// Office Supply Requisition (2026-10-26): its month, "NOVEMBER 2026" as on HR's sheet; a line's
// quantity with its unit, "2 BOX".
const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
export function osMonthLabel(v) {
  const m = /^(\d{4})-(\d{2})/.exec(String(v || ''));
  return m ? `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}` : '';
}
export const osQty = (it) => (it && it.quantity != null ? `${Number(it.quantity)}${it.unit ? ` ${it.unit}` : ''}` : '');

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
