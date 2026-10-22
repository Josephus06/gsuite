const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan, isSystemAdmin } = require('../middleware/auth');
const { insertNumbered } = require('../lib/docNumber');
const { computeLiquidationGl } = require('../lib/glImpact');
const { BILLABLE_FORM_TYPES, liquidationBilling } = require('../lib/liquidationPosting');
const { fundTransferRequestPosting } = require('../lib/fundTransferPosting');
const {
  DEPARTMENT_NOTED_TYPES, isDepartmentNoter, departmentsHeadedBy, notersFor,
  AP_NOTED_TYPES, isAccountsPayable, notersForDoc,
} = require('../lib/formNoters');
const { leaveRoute } = require('../lib/leaveRoute');
const { businessTripApprovers } = require('../lib/businessTripRoute');
const { notifyFormStatus } = require('../lib/approvalNotifications');

const router = express.Router();

// Forms -- the request forms ported from the Booking system's Request module. Four printed company
// forms sharing one approval chain. See db/create-forms.js for the schema and what changed in the
// port.
//
//   draft -> submitted -> noted -> approved
//                     \-> rejected -> (owner edits) -> back to noted or submitted
//
// EVERY STEP IS REQUIRED. Approving reads only from NOTED, so a department head's sign-off cannot
// be skipped by whoever approves. The source allowed submitted -> approved directly; it does not
// here. A form from a department with no head recorded therefore has nowhere to go until one is,
// which is why the refusal says so by name.
//
// TWO PAGES GATE THIS, and the split is the point:
//
//   /forms           the person filing. can_add raises and submits, can_edit revises, can_delete
//                    discards a draft, can_print prints, can_view_all widens "my forms" to all.
//   /forms/approval  the people ruling. can_edit NOTES, can_approve APPROVES or REJECTS.
//
// The source gated these on roles -- 'unitadmin' noted, 'administrator' approved. Two actions on
// the approval page say the same thing in the vocabulary this system already has, and keep the two
// stages separately grantable.
//
// EXCEPT FOR NOTING A LIQUIDATION OR A PAYMENT, which is not a permission at all: it is the head
// of the department the form came from, read off that department's ticket approver list. A
// permission cannot express "for YOUR department only", and an expense claim noted by the head of
// some other department is not the sign-off anybody wanted. See lib/formNoters.js.
//
// So a head needs no grant on /forms/approval to note their own department's forms, and holding
// can_edit there does NOT let somebody note a liquidation from a department they do not head.
const ROUTE = '/forms';
const APPROVAL_ROUTE = '/forms/approval';
// Forms with approvers of their own (2026-10-19): Leave (the filer's reporting line), Overtime (the
// department heads), Fuel (tagged Fuel Approvers). The Forms Approval page's approvers rule on the
// others -- and see only those, plus any of these three actually routed to them.
// Business Trip (2026-10-21): approved by the requestor's supervisor(s) (lib/businessTripRoute.js).
const OWN_APPROVER_TYPES = ['leave', 'undertime', 'overtime', 'fuel', 'business_trip'];
// Routed by the filer's reporting line (lib/leaveRoute.js): a Leave Application, and an Undertime
// Form (2026-10-20), which is time off the same way.
const LEAVE_ROUTED = ['leave', 'undertime'];
const routedWord = (doc) => (doc.type === 'undertime' ? 'undertime' : 'leave');

const TYPES = ['liquidation', 'payment', 'fund_transfer', 'business_trip', 'revolving_fund', 'attendance_adjustment', 'overtime', 'leave', 'undertime', 'gate_pass',
  'hmo_enrollment', 'hmo_deletion', 'bpi_deletion', 'fuel'];
const TYPE_LABELS = {
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
};
// Forms with no expense lines: a trip sheet, and the attendance adjustment slip.
const NO_ITEM_TYPES = ['business_trip', 'attendance_adjustment', 'overtime', 'leave', 'undertime', 'gate_pass', 'hmo_enrollment', 'hmo_deletion', 'bpi_deletion', 'fuel'];
// HR's member lists (asked 2026-10-19; db/add-hr-member-forms.js): Life & Health HMO enrollment and
// deletion, and the BPI payroll-account deletion letter. One lines table; each form its own columns
// (kept in step with client/src/utils/requestForms.js MEMBER_FORMS). required = a line needs these.
const MEMBER_FORMS = {
  hmo_enrollment: {
    fields: ['member_type', 'family_name', 'first_name', 'middle_initial', 'birthday', 'gender', 'civil_status', 'relationship', 'position', 'plan', 'remarks'],
    required: ['member_type', 'family_name', 'first_name'],
  },
  hmo_deletion: { fields: ['member_type', 'full_name', 'company', 'reason'], required: ['member_type', 'full_name', 'reason'] },
  bpi_deletion: { fields: ['full_name', 'bank_account_no', 'remarks'], required: ['full_name', 'bank_account_no'] },
};
const MEMBER_LIMITS = {
  member_type: 1, family_name: 120, first_name: 120, middle_initial: 10, full_name: 255, gender: 1, civil_status: 20,
  relationship: 60, position: 120, plan: 120, company: 255, reason: 500, bank_account_no: 60, remarks: 500,
};
const MAX_MEMBER_LINES = 200;
function memberLines(type, body) {
  const cfg = MEMBER_FORMS[type];
  return (Array.isArray(body.member_lines) ? body.member_lines : []).slice(0, MAX_MEMBER_LINES).map((l) => {
    const row = {};
    for (const f of cfg.fields) {
      if (f === 'birthday') row[f] = l?.[f] ? String(l[f]).slice(0, 10) : null;
      else row[f] = l?.[f] == null || String(l[f]).trim() === '' ? null : String(l[f]).trim().slice(0, MEMBER_LIMITS[f]);
    }
    if (row.member_type) row.member_type = row.member_type.toUpperCase();
    if (row.gender) row.gender = row.gender.toUpperCase();
    return row;
  }).filter((r) => cfg.fields.some((f) => r[f]));
}
async function memberDetail(id) {
  try {
    const [[d]] = await pool.query('SELECT * FROM form_member_details WHERE form_request_id = ?', [id]);
    const [lines] = await pool.query('SELECT * FROM form_member_lines WHERE form_request_id = ? ORDER BY line_no, id', [id]);
    return { ...(d || {}), lines };
  } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return null; throw e; }
}
// Employee Gate Pass (asked 2026-10-14; db/add-gate-pass-form.js). Its items are what is carried out
// -- a description and the department it belongs to -- not money lines, so they have their own table.
// The guard on duty (Edit on GUARD_ROUTE) records Time OUT / Time IN once it is approved.
const GUARD_ROUTE = '/forms/gate-pass-guard';
const MAX_GATE_ITEMS = 30;
const todayPh = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
async function gatePassDetail(id) {
  try {
    const [[d]] = await pool.query(
      `SELECT g.*, l.location_name, uo.display_name AS time_out_by_name, ui.display_name AS time_in_by_name
         FROM form_gate_pass_details g
         LEFT JOIN locations l ON l.id = g.location_id
         LEFT JOIN users uo ON uo.id = g.time_out_by_user_id
         LEFT JOIN users ui ON ui.id = g.time_in_by_user_id
        WHERE g.form_request_id = ?`, [id]);
    const [items] = await pool.query('SELECT id, line_no, description, department FROM form_gate_pass_items WHERE form_request_id = ? ORDER BY line_no, id', [id]);
    return d ? { ...d, items } : null;
  } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return null; throw e; }
}
// Leave Application (asked 2026-10-13; db/add-leave-form.js). 'others' carries free text.
const LEAVE_TYPES = ['sick', 'vacation', 'emergency', 'maternity', 'paternity', 'bereavement', 'birthday', 'solo_parent', 'without_pay', 'others'];
const DAY_PARTS = ['whole', 'am', 'pm'];
// Days of leave: every day from..to except Sundays; a half day (one date only) is 0.5.
function leaveDays(from, to, part) {
  if (!from || !to || to < from) return 0;
  if (from === to && part !== 'whole') return 0.5;
  let n = 0;
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0) n += 1;
  }
  return n;
}
// Attendance Adjustment (asked 2026-10-08): why the biometric has no time-in / time-out. The three
// reasons printed on the paper slip; 'others' carries the free text (e.g. "biometric error").
const ADJ_REASONS = ['field_work', 'business_trip', 'others'];
const ADJ_TIMES = ['am_in', 'am_out', 'pm_in', 'pm_out', 'ot_in', 'ot_out'];

// The six purposes printed on the liquidation form. 'others' is the one that carries free text.
const PURPOSES = [
  'business_travel_allowance', 'mobilization_installation', 'site_inspection',
  'representation', 'employees_benefit', 'others',
];

// A form that has left the owner's hands. Everything an approver can act on.
// Fund Transfer Request Form is a Request for Payment plus the bank it is paid from and the bank it goes to
// (2026-10-07): same details table, same approval path; only From and To are added.
const PAYMENT_TYPES = ['payment', 'fund_transfer'];

// The accounts From / To may name: the actual bank accounts under Cash in Bank (11000), each with the
// bank it sits under. Not the Cash on Hand funds (also typed "Bank"), and not the summary headings
// that only group accounts. is_active is not consulted: every bank account in the chart reads
// inactive (an import artifact, 2026-10-07), and the accounting Fund Transfer lists them all too.
const BANK_ACCOUNTS_SQL = `
  SELECT a.id, a.account_code, a.account_name, COALESCE(IF(p.account_code = '11000', NULL, p.account_name), a.account_name) AS bank_name
    FROM chart_of_accounts a
    JOIN chart_of_accounts p ON p.id = a.parent_account_id
    LEFT JOIN chart_of_accounts gp ON gp.id = p.parent_account_id
   WHERE a.detail_type = 'Bank' AND COALESCE(a.is_summary, 0) = 0
     AND (p.account_code = '11000' OR gp.account_code = '11000')`;

const WORKFLOW_STATUSES = ['submitted', 'noted', 'approved', 'rejected', 'accepted', 'declined'];
// The owner may edit a form until somebody acts on it: a draft, a submitted one nobody has noted
// yet, and a rejected one being revised.
const EDITABLE_STATUSES = ['draft', 'submitted', 'rejected'];

const trunc = (v, n) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, n));
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
// Dates arrive as 'YYYY-MM-DD' from a date input, or blank. A blank must be NULL, not '' -- MySQL
// would store '0000-00-00' for the latter and the printed form would show a date nobody entered.
const date = (v) => (v == null || String(v).trim() === '' ? null : String(v).slice(0, 10));
const time = (v) => (v == null || String(v).trim() === '' ? null : String(v).slice(0, 5));
// Undertime (2026-10-20): minutes between the time the employee leaves and their scheduled time out,
// both "HH:MM" on the same day. 0 or less = not early at all.
function undertimeMinutes(timeOut, shiftEnd) {
  if (!timeOut || !shiftEnd) return 0;
  const m = (t) => { const [h, mi] = String(t).slice(0, 5).split(':').map(Number); return h * 60 + mi; };
  return m(shiftEnd) - m(timeOut);
}

function badType(type) {
  return !TYPES.includes(type);
}

// The department picker sends a NAME, since that is what prints. Exact match only: a fuzzy match
// would route somebody's expense claim to the head of a department it never came from, which is
// worse than leaving it unrouted and saying so.
async function resolveDepartmentId(q, name) {
  if (!name) return null;
  const [[d]] = await q.query('SELECT id FROM departments WHERE name = ? LIMIT 1', [name]);
  return d ? d.id : null;
}

// Items are required on the three money forms and meaningless on a business trip. Returns an error
// string or null, so the caller answers with one 400 rather than a chain of ifs.
function readItems(body, { required }) {
  const rows = Array.isArray(body.items) ? body.items : [];
  const clean = rows
    .map((r) => ({
      item_date: date(r.date ?? r.item_date),
      particulars: trunc(r.particulars, 255),
      amount: num(r.amount),
      // Fund Transfer only (2026-10-13): this line's banks. Ignored for every other form.
      from_account_id: Number(r.from_account_id) || null,
      to_account_id: Number(r.to_account_id) || null,
    }))
    .filter((r) => r.particulars || r.amount);

  if (required && clean.length === 0) return { error: 'Add at least one line.' };
  for (const r of clean) {
    if (!r.particulars) return { error: 'Every line needs particulars.' };
    if (r.amount == null || !Number.isFinite(r.amount)) return { error: `Line "${r.particulars}" needs an amount.` };
    if (r.amount < 0) return { error: `Line "${r.particulars}" cannot be a negative amount.` };
  }
  return { items: clean };
}

// Sum of the lines, and what is left of the starting balance after them. Computed here rather than
// taken from the form: these two numbers appear on the printed document and must agree with the
// lines above them, which they cannot if somebody types them by hand.
function totals(items, startingBalance) {
  const spent = Number(items.reduce((s, r) => s + Number(r.amount || 0), 0).toFixed(2));
  const start = Number(startingBalance || 0);
  return { reimbursement_amount: spent, ending_balance: Number((start - spent).toFixed(2)) };
}

async function loadFull(id) {
  const [[doc]] = await pool.query(
    `SELECT f.*, u.display_name AS owner_name, u.username AS owner_username,
            nu.display_name AS noted_by_name, au.display_name AS approved_by_name,
            ru.display_name AS rejected_by_name,
            ca.account_code AS credit_account_code, ca.account_name AS credit_account_name
       FROM form_requests f
       LEFT JOIN chart_of_accounts ca ON ca.id = f.credit_account_id
       LEFT JOIN users u ON u.id = f.user_id
       LEFT JOIN users nu ON nu.id = f.noted_by
       LEFT JOIN users au ON au.id = f.approved_by
       LEFT JOIN users ru ON ru.id = f.rejected_by
      WHERE f.id = ?`, [id],
  );
  if (!doc) return null;

  const [items] = await pool.query(
    `SELECT i.id, i.item_date, i.particulars, i.amount, i.rejection_remark, i.cogs_account_id,
            a.account_code AS cogs_account_code, a.account_name AS cogs_account_name
       FROM form_request_items i LEFT JOIN chart_of_accounts a ON a.id = i.cogs_account_id
      WHERE i.form_request_id = ? ORDER BY i.id`,
    [id]);
  doc.items = items;
  // A Fund Transfer line's own From / To bank (2026-10-13; db/add-form-line-banks.js).
  if (doc.type === 'fund_transfer' && items.length) {
    try {
      const [banks] = await pool.query(
        `SELECT i.id, i.from_account_id, i.to_account_id,
                fa.account_code AS from_account_code, fa.account_name AS from_account_name,
                ta.account_code AS to_account_code, ta.account_name AS to_account_name
           FROM form_request_items i
           LEFT JOIN chart_of_accounts fa ON fa.id = i.from_account_id
           LEFT JOIN chart_of_accounts ta ON ta.id = i.to_account_id
          WHERE i.form_request_id = ?`, [id]);
      const byId = new Map(banks.map((b) => [b.id, b]));
      doc.items = items.map((it) => ({ ...it, ...(byId.get(it.id) || {}) }));
    } catch (e) { if (e.code !== 'ER_BAD_FIELD_ERROR') throw e; }
  }

  if (doc.type === 'liquidation') {
    const [[d]] = await pool.query('SELECT * FROM form_liquidation_details WHERE form_request_id = ?', [id]);
    doc.detail = d || null;
    const [p] = await pool.query(
      'SELECT purpose, other_text FROM form_liquidation_purposes WHERE form_request_id = ? ORDER BY id', [id]);
    doc.purposes = p;
  } else if (PAYMENT_TYPES.includes(doc.type)) {
    const [[d]] = await pool.query(
      `SELECT d.*, fa.account_code AS from_account_code, fa.account_name AS from_account_name,
              ta.account_code AS to_account_code, ta.account_name AS to_account_name
         FROM form_payment_details d
         LEFT JOIN chart_of_accounts fa ON fa.id = d.from_account_id
         LEFT JOIN chart_of_accounts ta ON ta.id = d.to_account_id
        WHERE d.form_request_id = ?`, [id]);
    doc.detail = d || null;
  } else if (doc.type === 'revolving_fund') {
    const [[d]] = await pool.query('SELECT * FROM form_revolving_fund_details WHERE form_request_id = ?', [id]);
    doc.detail = d || null;
  } else if (doc.type === 'business_trip') {
    const [[d]] = await pool.query('SELECT * FROM form_business_trip_details WHERE form_request_id = ?', [id]);
    doc.detail = d || null;
  } else if (doc.type === 'attendance_adjustment') {
    const [[d]] = await pool.query('SELECT * FROM form_attendance_adjustment_details WHERE form_request_id = ?', [id]);
    doc.detail = d || null;
  } else if (doc.type === 'overtime') {
    doc.detail = await overtimeDetail(id);
  } else if (doc.type === 'leave') {
    const [[d]] = await pool.query('SELECT * FROM form_leave_details WHERE form_request_id = ?', [id])
      .catch((e) => { if (e.code === 'ER_NO_SUCH_TABLE') return [[null]]; throw e; });
    doc.detail = d || null;
  } else if (doc.type === 'undertime') {
    const [[d]] = await pool.query('SELECT * FROM form_undertime_details WHERE form_request_id = ?', [id])
      .catch((e) => { if (e.code === 'ER_NO_SUCH_TABLE') return [[null]]; throw e; });
    doc.detail = d || null;
  } else if (doc.type === 'fuel') {
    const [[d]] = await pool.query(
      `SELECT d.*, vd.plate_no, a.serial_no, a.reference_no AS vehicle_reference, a.brand, a.model
         FROM form_fuel_details d LEFT JOIN assets a ON a.id = d.vehicle_asset_id
         LEFT JOIN vehicle_details vd ON vd.asset_id = d.vehicle_asset_id
        WHERE d.form_request_id = ?`, [id])
      .catch(async (e) => {
        if (e.code === 'ER_NO_SUCH_TABLE') return pool.query('SELECT * FROM form_fuel_details WHERE form_request_id = ?', [id]).catch(() => [[null]]);
        throw e;
      });
    if (d) {
      const plate = String(d.plate_no || d.serial_no || '').trim();
      d.vehicle_name = d.vehicle_asset_id ? [plate, [d.brand, d.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || d.vehicle_reference : d.vehicle_label;
      d.fuel_date = date(d.fuel_date instanceof Date ? d.fuel_date.toISOString() : d.fuel_date);
    }
    doc.detail = d || null;
    doc.fuel_usage = await fuelUsage(doc.user_id, d?.fuel_date, doc.id);
  } else if (doc.type === 'gate_pass') {
    doc.detail = await gatePassDetail(id);
  } else if (MEMBER_FORMS[doc.type]) {
    doc.detail = await memberDetail(id);
  }
  return doc;
}

/* -------------------------------------------------------------------------- */
/* Fuel Request (asked 2026-10-19; db/add-fuel-form.js)                        */
/* -------------------------------------------------------------------------- */
//
// A request for fuel: date, vehicle (a Fleet vehicle, or typed), litres, price / amount, odometer,
// station, purpose. Noted by the department head, approved like the other forms. A user ticked
// "Has monthly fuel limit" in Users & Permissions (users.has_fuel_limit / fuel_limit_liters) cannot
// SUBMIT a request that takes that calendar month past the limit -- submitted, noted and approved
// requests count; drafts, rejected and cancelled ones do not. Approved for a Fleet vehicle, it
// becomes that vehicle's fuel log entry (Assets > Fleet).
const FUEL_COUNTED = ['submitted', 'noted', 'approved'];
// Who approves a Fuel Request (2026-10-19): the users tagged Fuel Approver in Users & Permissions
// (users.is_fuel_approver) -- nobody notes it; it waits on them from the moment it is submitted.
async function fuelApprovers(q = pool) {
  const [rows] = await q.query('SELECT id, display_name FROM users WHERE is_fuel_approver = 1 AND is_active = 1 ORDER BY display_name')
    .catch((e) => { if (e.code === 'ER_BAD_FIELD_ERROR') return [[]]; throw e; });
  return rows;
}
async function fuelUsage(userId, onDate, excludeFormId = null, q = pool) {
  const [[u]] = await q.query('SELECT has_fuel_limit, fuel_limit_liters FROM users WHERE id = ?', [userId])
    .catch((e) => { if (e.code === 'ER_BAD_FIELD_ERROR') return [[null]]; throw e; });
  const month = String(onDate || new Date(Date.now() + 8 * 3600 * 1000).toISOString()).slice(0, 7);
  const [[used]] = await q.query(
    `SELECT COALESCE(SUM(d.liters), 0) AS l FROM form_fuel_details d JOIN form_requests f ON f.id = d.form_request_id
      WHERE f.user_id = ? AND f.type = 'fuel' AND f.status IN (?) AND DATE_FORMAT(d.fuel_date, '%Y-%m') = ? AND f.id <> ?`,
    [userId, FUEL_COUNTED, month, excludeFormId || 0]).catch((e) => { if (e.code === 'ER_NO_SUCH_TABLE') return [[{ l: 0 }]]; throw e; });
  const hasLimit = !!(u && u.has_fuel_limit && Number(u.fuel_limit_liters) > 0);
  const limit = hasLimit ? Number(u.fuel_limit_liters) : null;
  const usedL = Number(used.l) || 0;
  return { month, has_limit: hasLimit, limit, used: usedL, remaining: hasLimit ? Math.max(0, Number((limit - usedL).toFixed(3))) : null };
}

/* -------------------------------------------------------------------------- */
/* Overtime Request (asked 2026-10-13)                                         */
/* -------------------------------------------------------------------------- */
//
// Filed by anyone, for themself or for someone else:
//   for someone else  submitted -> NOTED by the filer's department head -> APPROVED by the
//                     employee's department head -> ACCEPTED / DECLINED by that employee
//   for themself      submitted -> APPROVED by their own department head (done)
// A department's heads are the ones ticked "Note forms" on it (lib/formNoters.js); the Forms
// Approval page's approvers do not take part -- whose overtime it is decides who rules on it.
async function overtimeDetail(formId, q = pool) {
  const [[d]] = await q.query(
    `SELECT o.*, tu.display_name AS target_name, td.name AS target_department
       FROM form_overtime_details o
       LEFT JOIN users tu ON tu.id = o.target_user_id
       LEFT JOIN departments td ON td.id = o.target_department_id
      WHERE o.form_request_id = ?`, [formId]).catch((e) => {
    if (e.code === 'ER_NO_SUCH_TABLE') return [[null]]; // db/add-overtime-form.js not run yet
    throw e;
  });
  return d || null;
}

// The employee's department, off their employee record.
async function userDepartmentId(q, userId) {
  const [[r]] = await q.query(
    'SELECT e.department_id FROM users u JOIN employees e ON e.id = u.employee_id WHERE u.id = ?', [userId]);
  return r ? r.department_id : null;
}

// Whose approval an overtime request waits on, and whether this user is one of them:
//   for themself  -- the filer's department heads, while SUBMITTED
//   for another   -- the employee's department heads, once NOTED
async function overtimeApproval(userId, doc, d) {
  if (!d) return { allowed: false, approvers: [], reason: 'This overtime request has no details.' };
  const deptId = d.for_self ? doc.department_id : d.target_department_id;
  const atStep = d.for_self ? doc.status === 'submitted' : doc.status === 'noted';
  const approvers = await notersFor(deptId, pool, 'overtime');
  const deptName = d.for_self ? (doc.department || 'the department') : (d.target_department || "the employee's department");
  if (!deptId) {
    return { allowed: false, approvers, reason: d.for_self ? 'This form has no department, so there is no head to approve it.' : `${d.target_name || 'The employee'} has no department on their employee record, so there is no head to approve it.` };
  }
  if (!approvers.length) return { allowed: false, approvers, reason: `${deptName} has no head recorded to approve this. Add one under that department's ticket approvers.` };
  const isApprover = approvers.some((a) => Number(a.id) === Number(userId));
  return {
    allowed: atStep && isApprover,
    approvers,
    reason: isApprover ? (atStep ? null : 'Not waiting on approval.') : `Only the head of ${deptName} can approve this: ${approvers.map((a) => a.display_name).join(' or ')}.`,
  };
}

// Who gives the final approval (NOTED -> APPROVED), for every type but overtime (overtimeApproval).
//
// A Leave Application follows the filer's reporting line (lib/leaveRoute.js, 2026-10-19): noted by
// their direct supervisor when there is one below the approver, approved by the first SBU / General
// Manager / department leave approver up the line (an SBU's own leave: whoever they report to).
// With nobody to note it waits on approval from the moment it is submitted. approvers: [] there
// means the Forms Approval page's approvers.
//   { allowed: may approve it now, eligible: is one of its approvers, approvers, noters }
const isMember = (list, userId) => list.some((a) => Number(a.id) === Number(userId));
async function mayApprove(userId, doc) {
  if (doc.type === 'fuel') {
    const approvers = await fuelApprovers();
    const atStep = ['submitted', 'noted'].includes(doc.status);
    const eligible = Number(userId) !== Number(doc.user_id) && isMember(approvers, userId);
    let reason = null;
    if (!approvers.length) reason = 'Nobody is tagged Fuel Approver -- tick it on the approver in Users & Permissions.';
    else if (!eligible) reason = Number(userId) === Number(doc.user_id) ? 'You cannot approve your own fuel request.' : `Only ${approvers.map((a) => a.display_name).join(' or ')} can approve fuel requests.`;
    else if (!atStep) reason = 'Not waiting on approval.';
    return { allowed: eligible && atStep, eligible, approvers, noters: [], reason };
  }
  if (LEAVE_ROUTED.includes(doc.type)) {
    const route = await leaveRoute(doc);
    const atStep = route.noters.length ? doc.status === 'noted' : ['submitted', 'noted'].includes(doc.status);
    // Never your own leave, even holding Approve on the Forms Approval page.
    const eligible = Number(userId) !== Number(doc.user_id)
      && (route.approvers.length ? isMember(route.approvers, userId) : await userCan(userId, APPROVAL_ROUTE, 'can_approve'));
    const waitingNote = route.noters.length > 0 && doc.status === 'submitted';
    let reason = null;
    if (!eligible) {
      reason = route.approvers.length
        ? `Only ${route.approvers.map((a) => a.display_name).join(' or ')} can approve this ${routedWord(doc)}.`
        : 'You do not have permission to perform this action';
    } else if (waitingNote) {
      reason = `This has to be noted first, by ${route.noters.map((a) => a.display_name).join(' or ')}.`;
    } else if (!atStep) {
      reason = 'Not waiting on approval.';
    }
    return { allowed: eligible && atStep, eligible, approvers: route.approvers, noters: route.noters, reason };
  }
  // A Business Trip: noted by the department head (as every department-noted form), then approved by
  // the requestor's supervisor(s); none set, the Forms Approval page's approvers.
  if (doc.type === 'business_trip') {
    const approvers = await businessTripApprovers(doc.user_id);
    const eligible = Number(userId) !== Number(doc.user_id)
      && (approvers.length ? isMember(approvers, userId) : await userCan(userId, APPROVAL_ROUTE, 'can_approve'));
    let reason = null;
    if (!eligible) {
      reason = Number(userId) === Number(doc.user_id) ? 'You cannot approve your own business trip.'
        : approvers.length ? `Only ${approvers.map((a) => a.display_name).join(' or ')} (the requestor's supervisor) can approve this business trip.`
          : 'You do not have permission to perform this action';
    }
    return { allowed: eligible && doc.status === 'noted', eligible, approvers, noters: [], reason };
  }
  const eligible = await userCan(userId, APPROVAL_ROUTE, 'can_approve');
  return { allowed: eligible && doc.status === 'noted', eligible, approvers: [], noters: [], reason: eligible ? null : 'You do not have permission to perform this action' };
}

// Who may look at one form. Its owner always; anyone holding can_view_all on /forms; the approvers,
// who cannot rule on what they cannot read; and the head of the department it came from, for the
// same reason -- they are the one who has to note it.
async function maySee(userId, doc) {
  // Heading the department comes first because it is the one route in that does NOT depend on a
  // page grant -- a head may hold nothing on /forms and still have to note this.
  if (await isDepartmentNoter(userId, doc.department_id)) return true;
  // AP has to open every liquidation it notes, whoever's department it came from.
  if (AP_NOTED_TYPES.includes(doc.type) && await isAccountsPayable(userId)) return true;
  // HRD > OBT (2026-10-20, routes/obt.js): HR opens each approved Official Business Trip it confirms.
  if (doc.type === 'business_trip' && doc.status === 'approved' && await userCan(userId, '/hrd/obt', 'can_view')) return true;
  // Only the approvers see every form (2026-10-13) -- each one reaches them. View on the approval page
  // alone no longer opens everyone's forms: a user sees the ones they are involved in.
  // The Forms Approval page's approvers: the types they rule on (Leave / Overtime / Fuel by their own
  // routes, below).
  const pageApprover = await userCan(userId, APPROVAL_ROUTE, 'can_approve');
  if (pageApprover && !OWN_APPROVER_TYPES.includes(doc.type)) return true;
  if (await userCan(userId, ROUTE, 'can_view_all')) return true;
  if (await userCan(userId, APPROVAL_ROUTE, 'can_view_all')) return true;
  // One they have already acted on -- noted, approved or rejected.
  if ([doc.noted_by, doc.approved_by, doc.rejected_by].some((u) => u != null && Number(u) === Number(userId))) return true;
  // A Business Trip: the requestor's supervisor(s), who approve it.
  if (doc.type === 'business_trip') {
    const sups = await businessTripApprovers(doc.user_id);
    if (isMember(sups, userId)) return true;
    if (pageApprover && !sups.length) return true; // no supervisor set: falls to the page's approvers
  }
  // A Fuel Request: its tagged approvers.
  if (doc.type === 'fuel' && isMember(await fuelApprovers(), userId)) return true;
  // A Leave Application: the supervisor who notes it and whoever approves it (lib/leaveRoute.js).
  if (LEAVE_ROUTED.includes(doc.type)) {
    const route = await leaveRoute(doc);
    if (isMember(route.noters, userId) || isMember(route.approvers, userId)) return true;
    if (pageApprover && !route.approvers.length) return true; // falls to the page's approvers
  }
  // An overtime request: the employee it is for, and their department's heads, who approve it.
  if (doc.type === 'overtime') {
    const d = await overtimeDetail(doc.id);
    if (d && Number(d.target_user_id) === Number(userId)) return true;
    // An artist's overtime: the Design Supervisors, who confirm its actual time.
    if (d && (await otConfirmRule(doc, d)).confirmers.some((c) => Number(c.id) === Number(userId))) return true;
    if (d && d.target_department_id && await isDepartmentNoter(userId, d.target_department_id)) return true;
  }
  // Your own form, provided you still hold the module at all.
  return doc.user_id === userId && userCan(userId, ROUTE, 'can_view');
}

// May this user note this particular form, and if not, why not? One answer used by the button, the
// endpoint and the explanation on screen, so the three cannot disagree.
async function mayNote(userId, doc) {
  // A Fuel Request is not noted -- it goes straight to its tagged approvers (2026-10-19).
  if (doc.type === 'fuel') return { allowed: false, reason: 'A fuel request goes straight to its approver -- there is nothing to note.' };
  // A Leave Application is noted by the filer's direct supervisor, when the line has one below the
  // approver (lib/leaveRoute.js); otherwise it goes straight to approval.
  if (LEAVE_ROUTED.includes(doc.type)) {
    const route = await leaveRoute(doc);
    if (!route.noters.length) return { allowed: false, reason: `This ${routedWord(doc)} goes straight to approval -- there is nothing to note.` };
    if (isMember(route.noters, userId)) return { allowed: true };
    return { allowed: false, reason: `Only ${route.noters.map((a) => a.display_name).join(' or ')} can note this ${routedWord(doc)}.` };
  }
  // An overtime request for yourself goes straight to your head for approval -- nothing to note.
  if (doc.type === 'overtime') {
    const d = await overtimeDetail(doc.id);
    if (d && d.for_self) return { allowed: false, reason: 'An overtime request for yourself goes straight to your department head for approval.' };
  }
  // A liquidation is noted by Accounts Payable, and only once every item has its COGS account --
  // the COGS check is in the note route itself, so the screen can say what is missing.
  if (AP_NOTED_TYPES.includes(doc.type)) {
    if (await isAccountsPayable(userId)) return { allowed: true };
    const ap = await notersForDoc(doc);
    return {
      allowed: false,
      reason: ap.length
        ? `Only Accounts Payable can note a liquidation: ${ap.map((u) => u.display_name).join(' or ')}.`
        : 'Nobody is marked Accounts Payable, so nobody can note this. Tick "Accounts Payable" on the AP staff under Users & Permissions.',
    };
  }
  if (DEPARTMENT_NOTED_TYPES.includes(doc.type)) {
    if (!doc.department_id) {
      return {
        allowed: false,
        reason: doc.department
          ? `"${doc.department}" is not a department in this system, so nobody heads it. An approver can still approve this directly.`
          : 'This form has no department, so there is no head to note it. An approver can still approve it directly.',
      };
    }
    if (await isDepartmentNoter(userId, doc.department_id, pool, doc.type)) return { allowed: true };

    const heads = await notersFor(doc.department_id, pool, doc.type);
    return {
      allowed: false,
      reason: heads.length
        ? `Only the head of ${doc.department} can note this: ${heads.map((h) => h.display_name).join(' or ')}.`
        : `${doc.department} has no head recorded, so nobody can note this. Add one under that department's ticket approvers, or have an approver approve it directly.`,
    };
  }

  // Every type is noted by a ticked noter above. An approver does not note (2026-10-09) -- the
  // Forms Approval page permission used to let one note a business trip.
  return { allowed: false, reason: 'Only those ticked to note forms can note this.' };
}

/* -------------------------------------------------------------------------- */
/* Listing                                                                     */
/* -------------------------------------------------------------------------- */

// The owner's list. Shows your own forms, or everyone's if you hold can_view_all.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];

    if (!(await userCan(req.user.id, ROUTE, 'can_view_all'))) {
      where.push('f.user_id = ?');
      params.push(req.user.id);
    }
    if (req.query.status) { where.push('f.status = ?'); params.push(req.query.status); }
    if (req.query.type && TYPES.includes(req.query.type)) { where.push('f.type = ?'); params.push(req.query.type); }
    if (req.query.search) {
      where.push('(f.request_no LIKE ? OR f.name LIKE ? OR f.department LIKE ? OR u.display_name LIKE ?)');
      const like = `%${req.query.search}%`;
      params.push(like, like, like, like);
    }

    const [rows] = await pool.query(
      `SELECT f.id, f.request_no, f.type, f.status, f.department, f.name, f.created_at, f.submitted_at,
              u.display_name AS owner_name,
              (SELECT COALESCE(SUM(i.amount), 0) FROM form_request_items i WHERE i.form_request_id = f.id) AS total_amount
         FROM form_requests f
         LEFT JOIN users u ON u.id = f.user_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY f.id DESC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// The approval queue. Only what has actually been sent for a decision -- a draft is nobody's
// business but its owner's.
//
// Two ways in, because noting a liquidation is not a permission: either can_view on the approval
// page, which shows everything, or heading a department, which shows that department's forms. A
// head who had to be granted the whole approval page to find their own team's expense claims would
// also be granted sight of every other department's.
// The open leave forms this user notes or approves by the filer's reporting line. Computed per
// form -- the line is a walk up user_supervisors, not something one SQL join expresses.
async function leaveWaitingOn(userId, isPageApprover = false) {
  const [open] = await pool.query(
    "SELECT id, type, status, user_id, department_id FROM form_requests WHERE type IN ('leave', 'undertime') AND status IN ('submitted', 'noted')");
  const ids = [];
  for (const doc of open) {
    const route = await leaveRoute(doc);
    // A leave with no named approver falls to the Forms Approval page's approvers.
    const pageFallback = isPageApprover && !route.approvers.length && Number(doc.user_id) !== Number(userId);
    if (isMember(route.noters, userId) || isMember(route.approvers, userId) || pageFallback) ids.push(doc.id);
  }
  return ids;
}

router.get('/approval/queue', requireAuth, async (req, res, next) => {
  try {
    // Users see only the forms they are involved in (2026-10-13). View All on this page shows every
    // form (2026-10-19). An approver (can_approve) sees the types the page's approvers rule on, and a
    // Leave / Overtime / Fuel only when it is routed to them (asked 2026-10-19: an overtime request
    // that never goes to the General Manager is not on the General Manager's list).
    const canSeeAll = await userCan(req.user.id, APPROVAL_ROUTE, 'can_view_all');
    const pageApprover = !canSeeAll && await userCan(req.user.id, APPROVAL_ROUTE, 'can_approve');
    const headOf = canSeeAll ? [] : await departmentsHeadedBy(req.user.id);
    // Accounts Payable sees every liquidation, since it notes them all.
    const isAp = canSeeAll ? false : await isAccountsPayable(req.user.id);
    // Overtime (2026-10-13): the employee a request is for sees it, to accept or decline it.
    const [[otMine]] = canSeeAll ? [[null]] : await pool.query(
      'SELECT 1 AS x FROM form_overtime_details WHERE target_user_id = ? LIMIT 1', [req.user.id]).catch(() => [[null]]);
    const pageViewer = canSeeAll ? true : await userCan(req.user.id, APPROVAL_ROUTE, 'can_view');
    // Leave waiting on this user by the filer's reporting line (lib/leaveRoute.js, 2026-10-19).
    const leaveIds = canSeeAll ? [] : await leaveWaitingOn(req.user.id, pageApprover);
    // Tagged Fuel Approver: every fuel request (2026-10-19).
    const fuelApprover = canSeeAll ? false : isMember(await fuelApprovers(), req.user.id);
    // Supervisor of someone (user_supervisors): their people's Business Trips (2026-10-21).
    const [[supOf]] = canSeeAll ? [[null]] : await pool.query(
      'SELECT 1 AS x FROM user_supervisors WHERE supervisor_id = ? AND user_id <> ? LIMIT 1', [req.user.id, req.user.id]).catch(() => [[null]]);
    if (!canSeeAll && !pageApprover && !pageViewer && headOf.length === 0 && !isAp && !otMine && !leaveIds.length && !fuelApprover && !supOf) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }

    const where = ['f.status IN (?)'];
    const params = [WORKFLOW_STATUSES];
    if (!canSeeAll) {
      const mine = [];
      // Only the forms this head notes in that department (note_form_types; empty = all of them).
      if (headOf.length) {
        mine.push(`(f.type IN (?) AND EXISTS (SELECT 1 FROM department_ticket_approvers a
                   WHERE a.department_id = f.department_id AND a.user_id = ? AND a.can_note_form = 1
                     AND (a.note_form_types IS NULL OR a.note_form_types = '' OR FIND_IN_SET(f.type, a.note_form_types) > 0)))`);
        params.push(DEPARTMENT_NOTED_TYPES, req.user.id);
      }
      if (isAp) { mine.push('f.type IN (?)'); params.push(AP_NOTED_TYPES); }
      // Overtime filed for someone in a department this user heads (they approve it), or for this user.
      if (headOf.length) {
        mine.push(`(f.type = 'overtime' AND EXISTS (SELECT 1 FROM form_overtime_details o
                   JOIN department_ticket_approvers a ON a.department_id = o.target_department_id
                  WHERE o.form_request_id = f.id AND a.user_id = ? AND a.can_note_form = 1
                    AND (a.note_form_types IS NULL OR a.note_form_types = '' OR FIND_IN_SET('overtime', a.note_form_types) > 0)))`);
        params.push(req.user.id);
      }
      if (otMine) {
        mine.push("(f.type = 'overtime' AND EXISTS (SELECT 1 FROM form_overtime_details o WHERE o.form_request_id = f.id AND o.target_user_id = ?))");
        params.push(req.user.id);
      }
      if (leaveIds.length) { mine.push('f.id IN (?)'); params.push(leaveIds); }
      if (fuelApprover) mine.push("f.type = 'fuel'");
      // Business Trips of the people this user supervises; and, for the page's approvers, those of
      // requestors with no active supervisor set (the fallback in lib/businessTripRoute.js).
      if (supOf) {
        mine.push("(f.type = 'business_trip' AND EXISTS (SELECT 1 FROM user_supervisors us WHERE us.user_id = f.user_id AND us.supervisor_id = ? AND us.user_id <> us.supervisor_id))");
        params.push(req.user.id);
      }
      if (pageApprover) {
        mine.push(`(f.type = 'business_trip' AND NOT EXISTS (SELECT 1 FROM user_supervisors us JOIN users su ON su.id = us.supervisor_id
                    WHERE us.user_id = f.user_id AND su.is_active = 1 AND su.id <> f.user_id))`);
      }
      if (pageApprover) { mine.push('f.type NOT IN (?)'); params.push(OWN_APPROVER_TYPES); }
      // Their own forms, and the ones they noted, approved or rejected.
      mine.push('(f.user_id = ? OR f.noted_by = ? OR f.approved_by = ? OR f.rejected_by = ?)');
      params.push(req.user.id, req.user.id, req.user.id, req.user.id);
      where.push(`(${mine.join(' OR ')})`);
    }
    if (req.query.status && WORKFLOW_STATUSES.includes(req.query.status)) {
      where.push('f.status = ?'); params.push(req.query.status);
    }
    if (req.query.type && TYPES.includes(req.query.type)) { where.push('f.type = ?'); params.push(req.query.type); }

    const [rows] = await pool.query(
      `SELECT f.id, f.request_no, f.type, f.status, f.department, f.name, f.created_at, f.submitted_at, f.noted_at,
              u.display_name AS owner_name,
              (SELECT COALESCE(SUM(i.amount), 0) FROM form_request_items i WHERE i.form_request_id = f.id) AS total_amount
         FROM form_requests f
         LEFT JOIN users u ON u.id = f.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY FIELD(f.status, 'submitted', 'noted', 'rejected', 'approved', 'accepted', 'declined'), f.id DESC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// The accounts a liquidation item can be charged to -- active, postable Expense accounts (cost of
// sales sits there in this chart). For Accounts Payable only, who assigns them.
// The Chart of Accounts for AP's two pickers on a liquidation -- each item's COGS account and the
// credit account. The WHOLE active chart (asked 2026-10-06: "wire it to chart of account"): the first
// cut filtered to account_type 'Expense' / is_summary = 0, which on the live chart returned nothing.
// Every postable (non-summary) account, as the Journal lists them. is_active is NOT consulted: 237 of
// the 278 accounts read inactive (an import artifact), so filtering on it hid e.g. 30631 Postage And
// Delivery (2026-10-07).
async function activeAccounts() {
  const [rows] = await pool.query(
    'SELECT id, account_code, account_name, account_type FROM chart_of_accounts WHERE COALESCE(is_summary, 0) = 0 ORDER BY account_code');
  return rows;
}
// The account lists behind the liquidation's pickers. A System Admin too (2026-10-19): an approved
// liquidation's accounts are theirs to change, and refusing them the list left every picker blank
// under an "Only Accounts Payable sets this." banner (REQ-89).
const mayPickLiquidationAccounts = async (userId) => (await isAccountsPayable(userId)) || (await isSystemAdmin(userId));
router.get('/meta/credit-accounts', requireAuth, async (req, res, next) => {
  try {
    if (!(await mayPickLiquidationAccounts(req.user.id))) return res.status(403).json({ error: 'Only Accounts Payable sets this.' });
    res.json(await activeAccounts());
  } catch (err) { next(err); }
});

// The liquidation's credit account. Empty = the default (13305). Who and when: see below.
router.put('/:id/credit-account', requireAuth, async (req, res, next) => {
  try {
    const [[doc]] = await pool.query('SELECT id, type, status FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!AP_NOTED_TYPES.includes(doc.type)) return res.status(409).json({ error: 'Only a liquidation has a credit account.' });
    // The same rule as the items' accounts (2026-10-19): Accounts Payable up to noted, a System Admin
    // only once approved -- and never once anything is posted, since every Vendor Bill or Journal made
    // from the liquidation credits this account.
    const admin = await isSystemAdmin(req.user.id);
    if (doc.status === 'approved' && !admin) return res.status(403).json({ error: 'This liquidation is approved -- only a System Admin can change its credit account.' });
    if (!admin && !(await isAccountsPayable(req.user.id))) return res.status(403).json({ error: 'Only Accounts Payable sets this.' });
    if (!['submitted', 'noted', 'approved'].includes(doc.status)) return res.status(409).json({ error: 'The credit account can only be changed while the liquidation is submitted, noted or approved.' });
    if (doc.status !== 'submitted') {
      const billing = await liquidationBilling(pool, doc.id);
      if (billing.journal) return res.status(409).json({ error: `This liquidation is posted by ${billing.journal.journal_no}; its credit account is fixed there.` });
      if (billing.bills.length) return res.status(409).json({ error: `This liquidation is already on ${billing.bills.map((b) => b.bill_no).join(', ')}; its credit account is fixed there.` });
    }
    const accountId = req.body?.credit_account_id ? Number(req.body.credit_account_id) : null;
    if (accountId) {
      const [[acct]] = await pool.query(
        'SELECT id FROM chart_of_accounts WHERE id = ? AND COALESCE(is_summary, 0) = 0', [accountId]);
      if (!acct) return res.status(400).json({ error: 'Choose an active account from the Chart of Accounts.' });
    }
    const [[before]] = await pool.query(
      `SELECT CONCAT(c.account_code, ' — ', c.account_name) AS label FROM form_requests f
         LEFT JOIN chart_of_accounts c ON c.id = f.credit_account_id WHERE f.id = ?`, [doc.id]);
    await pool.query('UPDATE form_requests SET credit_account_id = ?, updated_at = NOW() WHERE id = ?', [accountId, doc.id]);
    const [[after]] = accountId
      ? await pool.query("SELECT CONCAT(account_code, ' — ', account_name) AS label FROM chart_of_accounts WHERE id = ?", [accountId])
      : [[{ label: null }]];
    await logFormAudit(pool, doc.id, req.user.id, 'Updated', 'Credit Account', before?.label || 'Default', after?.label || 'Default');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/meta/cogs-accounts', requireAuth, async (req, res, next) => {
  try {
    if (!(await mayPickLiquidationAccounts(req.user.id))) return res.status(403).json({ error: 'Only Accounts Payable assigns COGS.' });
    res.json(await activeAccounts());
  } catch (err) { next(err); }
});

// Assign one liquidation item's COGS account (asked 2026-10-06). Accounts Payable (or a System Admin)
// while it waits to be noted -- every item needs one before AP can note it -- and, since 2026-10-19,
// after it is noted too; once approved, a System Admin only (REQ-89). Never once the item
// is posted: a line on a live Vendor Bill, or a liquidation posted by Journal, keeps the account the
// books already carry -- change it there (cancel the bill / void the journal) instead.
async function cogsEditBlock(doc, itemId) {
  if (!['submitted', 'noted', 'approved'].includes(doc.status)) return 'The accounts can only be changed while the liquidation is submitted, noted or approved.';
  if (doc.status === 'submitted') return null;
  const billing = await liquidationBilling(pool, doc.id);
  if (billing.journal) return `This liquidation is posted by ${billing.journal.journal_no}; its accounts are fixed there.`;
  if (itemId && billing.billOfItem.has(Number(itemId))) return `This line is on ${billing.billOfItem.get(Number(itemId))}; its account is fixed there.`;
  return null;
}
router.put('/:id/items/:itemId/cogs', requireAuth, async (req, res, next) => {
  try {
    const [[doc]] = await pool.query('SELECT id, type, status FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!AP_NOTED_TYPES.includes(doc.type)) return res.status(409).json({ error: 'Only a liquidation\'s items take a COGS account.' });
    // Once approved, only a System Admin may change what was set (asked 2026-10-19); before that,
    // Accounts Payable (or a System Admin).
    const admin = await isSystemAdmin(req.user.id);
    if (doc.status === 'approved' && !admin) return res.status(403).json({ error: 'This liquidation is approved -- only a System Admin can change its accounts.' });
    if (!admin && !(await isAccountsPayable(req.user.id))) return res.status(403).json({ error: 'Only Accounts Payable assigns COGS.' });
    const blocked = await cogsEditBlock(doc, req.params.itemId);
    if (blocked) return res.status(409).json({ error: blocked });
    const accountId = req.body?.cogs_account_id ? Number(req.body.cogs_account_id) : null;
    if (accountId) {
      const [[acct]] = await pool.query(
        'SELECT id FROM chart_of_accounts WHERE id = ? AND COALESCE(is_summary, 0) = 0', [accountId]);
      if (!acct) return res.status(400).json({ error: 'Choose an active account from the Chart of Accounts.' });
    }
    const [r] = await pool.query(
      'UPDATE form_request_items SET cogs_account_id = ? WHERE id = ? AND form_request_id = ?',
      [accountId, req.params.itemId, doc.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Item not found' });
    const [[line]] = await pool.query(
      `SELECT i.particulars, CONCAT(c.account_code, ' — ', c.account_name) AS label FROM form_request_items i
         LEFT JOIN chart_of_accounts c ON c.id = i.cogs_account_id WHERE i.id = ?`, [req.params.itemId]);
    await logFormAudit(pool, doc.id, req.user.id, 'Updated', `COGS Account (${String(line?.particulars || 'item').slice(0, 100)})`, null, line?.label || 'None');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Fuel Request's pickers: the Fleet vehicles, and this user's limit and what is left this month.
router.get('/meta/fuel', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [vehicles] = await pool.query(
      `SELECT a.id AS asset_id, TRIM(COALESCE(vd.plate_no, a.serial_no)) AS plate_no, a.brand, a.model, a.reference_no
         FROM assets a LEFT JOIN asset_items ai ON ai.id = a.asset_item_id LEFT JOIN asset_classes ac ON ac.id = a.asset_class_id
         LEFT JOIN vehicle_details vd ON vd.asset_id = a.id
        WHERE ac.name LIKE '%Transport%' OR ac.name LIKE '%Vehicle%' OR ai.category LIKE '%Vehicle%' OR ai.category LIKE '%Transport%'
           OR ai.display_name REGEXP '(^|[^a-z])(vehicles?|motorcycles?|motorbikes?|trucks?|vans?|cars?)([^a-z]|$)' OR vd.asset_id IS NOT NULL
        ORDER BY plate_no`).catch((e) => { if (e.code === 'ER_NO_SUCH_TABLE') return [[]]; throw e; });
    res.json({ vehicles, usage: await fuelUsage(req.user.id, date(req.query.date), Number(req.query.exclude) || null) });
  } catch (err) { next(err); }
});

// Who confirms an overtime's ACTUAL time: the person who filed it -- except overtime FOR AN ARTIST
// (the employee it is for is account type Artist), which the Design Supervisors confirm (asked
// 2026-10-21): users ticked Design Supervisor whose account type is Artist (or Design Supervisor) --
// the design leads; Sales users also carry the tick, to assign artists, and do not confirm. None: the filer.
//   { byDesignSupervisor, confirmers: [{ id, display_name }] }
async function otConfirmRule(doc, d) {
  const targetId = d && !Number(d.for_self) ? Number(d.target_user_id) : Number(doc.user_id);
  const [[t]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [targetId]);
  if (String(t?.account_type || '').toLowerCase() === 'artist') {
    const [sups] = await pool.query(
      "SELECT id, display_name FROM users WHERE is_design_supervisor = 1 AND is_active = 1 AND LOWER(account_type) IN ('artist', 'design supervisor') AND id <> ? ORDER BY display_name", [targetId])
      .catch(() => [[]]);
    if (sups.length) return { byDesignSupervisor: true, confirmers: sups };
  }
  const [[filer]] = await pool.query('SELECT id, display_name FROM users WHERE id = ?', [doc.user_id]);
  return { byDesignSupervisor: false, confirmers: filer ? [filer] : [] };
}

// Overtime waiting on its ACTUAL time (2026-10-20, see /:id/ot-confirm): final -- approved for
// yourself, accepted for someone else -- and not yet confirmed. Each row says whose move it is: the
// FILER confirms, or for an artist the Design Supervisors (otConfirmRule); the employee it is for sees
// it to monitor.
router.get('/meta/ot-to-confirm', requireAuth, async (req, res, next) => {
  try {
    const me = req.user.id;
    const [rows] = await pool.query(
      `SELECT f.id, f.request_no, f.status, f.user_id, fu.display_name AS filed_by,
              o.for_self, o.target_user_id, tu.display_name AS target_name,
              o.ot_date, o.time_from, o.time_to, o.hours, o.purpose
         FROM form_requests f
         JOIN form_overtime_details o ON o.form_request_id = f.id
         LEFT JOIN users fu ON fu.id = f.user_id
         LEFT JOIN users tu ON tu.id = o.target_user_id
        WHERE f.type = 'overtime' AND o.ot_confirmed_at IS NULL
          AND ((o.for_self = 1 AND f.status = 'approved') OR (o.for_self = 0 AND f.status = 'accepted'))
          AND (f.user_id = ? OR o.target_user_id = ?
               -- a Design Supervisor: every artist's overtime, which they confirm
               OR (EXISTS (SELECT 1 FROM users me WHERE me.id = ? AND me.is_design_supervisor = 1 AND LOWER(me.account_type) IN ('artist', 'design supervisor'))
                   AND (SELECT LOWER(au.account_type) FROM users au WHERE au.id = IF(o.for_self = 1, f.user_id, o.target_user_id)) = 'artist'))
        ORDER BY o.ot_date DESC, f.id DESC
        LIMIT 200`, [me, me, me]);
    const out = [];
    for (const r of rows) {
      const rule = await otConfirmRule({ user_id: r.user_id }, r);
      out.push({
        ...r, for_self: !!Number(r.for_self),
        mine_to_confirm: rule.confirmers.some((c) => Number(c.id) === Number(me)),
        confirmed_by: rule.byDesignSupervisor ? 'Design Supervisor' : r.filed_by,
      });
    }
    res.json(out);
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_NO_SUCH_TABLE') return res.json([]); // add-ot-confirmation.js not run
    next(err);
  }
});

router.get('/meta/options', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    // Departments come from the same list every other module uses, so a form's department is a
    // real one rather than whatever was typed that day.
    const [departments] = await pool.query('SELECT id, name FROM departments ORDER BY name');
    // Employee Gate Pass: the Location it is issued at.
    const [locations] = await pool.query('SELECT id, location_name FROM locations WHERE is_active = 1 ORDER BY location_name');
    // From / To on a Fund Transfer Request Form: the bank accounts under Cash in Bank (BANK_ACCOUNTS_SQL).
    const [bankAccounts] = await pool.query(`${BANK_ACCOUNTS_SQL} ORDER BY a.account_code`);
    res.json({
      types: TYPES.map((t) => ({ key: t, label: TYPE_LABELS[t] })),
      purposes: PURPOSES,
      departments: departments.map((d) => d.name),
      locations,
      bank_accounts: bankAccounts,
      // Overtime Request: anyone active with a login, and the department on their employee record.
      ot_people: (await pool.query(
        `SELECT u.id, u.display_name AS name, d.name AS department
           FROM users u LEFT JOIN employees e ON e.id = u.employee_id LEFT JOIN departments d ON d.id = e.department_id
          WHERE u.is_active = 1 ORDER BY u.display_name`))[0],
      can: {
        note: await userCan(req.user.id, APPROVAL_ROUTE, 'can_edit'),
        approve: await userCan(req.user.id, APPROVAL_ROUTE, 'can_approve'),
        view_all: await userCan(req.user.id, ROUTE, 'can_view_all'),
      },
    });
  } catch (err) { next(err); }
});

// Opening one form. Gated by maySee ALONE, not by can_view on /forms as well: the head of a
// department has to be able to open the forms only they can note, and heading a department is not
// a page grant. Requiring both would leave a head able to note a form they cannot read.
/* -------------------------------------------------------------------------- */
/* System Information (every form type, asked 2026-10-09)                     */
/* -------------------------------------------------------------------------- */

// One row per thing that happened to a form, in the shared audit_logs table. Its event_type is an
// enum, so a submit or a note is a 'Status Change' and a rejection is 'Disapproved'.
async function logFormAudit(db, formId, userId, eventType, fieldName = null, oldValue = null, newValue = null) {
  await db.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('FormRequest', ?, ?, ?, ?, ?, ?)`,
    [formId, eventType, fieldName,
      oldValue === null || oldValue === undefined ? null : String(oldValue),
      newValue === null || newValue === undefined ? null : String(newValue), userId || null]);
}

const STATUS_LABEL = { draft: 'Draft', submitted: 'Submitted', noted: 'Noted', approved: 'Approved', rejected: 'Rejected', accepted: 'Accepted', declined: 'Declined' };

// Who made it and when, who last changed it, and its history. Forms filed before the history was
// kept get theirs from the form's own dates (created, submitted, noted, approved, rejected) -- any
// event the log already holds is not repeated.
router.get('/:id/system-info', requireAuth, async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      `SELECT f.id, f.type, f.status, f.user_id, f.department_id, f.created_at, f.updated_at, f.submitted_at,
              f.noted_at, f.approved_at, f.rejected_at, f.rejection_reason, f.noted_by, f.approved_by, f.rejected_by,
              u.display_name AS owner_name, nu.display_name AS noted_by_name,
              au.display_name AS approved_by_name, ru.display_name AS rejected_by_name
         FROM form_requests f
         LEFT JOIN users u ON u.id = f.user_id
         LEFT JOIN users nu ON nu.id = f.noted_by
         LEFT JOIN users au ON au.id = f.approved_by
         LEFT JOIN users ru ON ru.id = f.rejected_by
        WHERE f.id = ?`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!(await maySee(req.user.id, doc))) return res.status(403).json({ error: 'This form is not yours to view.' });

    const [logged] = await pool.query(
      `SELECT a.id, a.event_type, a.field_name, a.old_value, a.new_value, a.set_at, a.set_by_user_id, u.display_name AS set_by_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
        WHERE a.auditable_type = 'FormRequest' AND a.auditable_id = ?`, [doc.id]);
    const has = (event, value) => logged.some((l) => l.event_type === event && (value === undefined || l.new_value === value));
    const derived = [];
    const add = (when, by, byName, event, field, oldValue, newValue) => {
      if (when) derived.push({ id: `d-${derived.length}`, event_type: event, field_name: field, old_value: oldValue, new_value: newValue, set_at: when, set_by_user_id: by, set_by_name: byName, derived: true });
    };
    if (!has('Created')) add(doc.created_at, doc.user_id, doc.owner_name, 'Created', null, null, null);
    if (!has('Status Change', 'Submitted')) add(doc.submitted_at, doc.user_id, doc.owner_name, 'Status Change', 'Status', 'Draft', 'Submitted');
    if (!has('Status Change', 'Noted')) add(doc.noted_at, doc.noted_by, doc.noted_by_name, 'Status Change', 'Status', 'Submitted', 'Noted');
    if (!has('Approved')) add(doc.approved_at, doc.approved_by, doc.approved_by_name, 'Approved', 'Status', 'Noted', 'Approved');
    if (!has('Disapproved')) add(doc.rejected_at, doc.rejected_by, doc.rejected_by_name, 'Disapproved', 'Reason', null, doc.rejection_reason);

    const history = [...logged, ...derived].sort((a, b) => String(b.set_at).localeCompare(String(a.set_at)) || String(b.id).localeCompare(String(a.id)));
    const lastChange = history.find((h) => h.event_type !== 'Created');
    res.json({
      created_at: doc.created_at,
      created_by_name: doc.owner_name || null,
      updated_at: doc.updated_at,
      updated_by_name: lastChange?.set_by_name || doc.owner_name || null,
      status: STATUS_LABEL[doc.status] || doc.status,
      history,
    });
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const doc = await loadFull(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!(await maySee(req.user.id, doc))) return res.status(403).json({ error: 'This form is not yours to view.' });

    doc.type_label = TYPE_LABELS[doc.type] || doc.type;
    doc.is_owner = doc.user_id === req.user.id;
    // The owner while it is still open; a System Admin always.
    doc.can_edit = (await userCan(req.user.id, ROUTE, 'can_edit'))
      && ((doc.is_owner && EDITABLE_STATUSES.includes(doc.status)) || await isSystemAdmin(req.user.id));

    const note = await mayNote(req.user.id, doc);
    doc.can_note = note.allowed;
    // Why not, when not -- shown against a form that is sitting at SUBMITTED, so a dead end reads
    // as "waiting on X" rather than as a missing button.
    doc.note_blocked_reason = note.allowed ? null : note.reason;
    // Who it is waiting on, named, whoever is looking. The owner wants to know who to chase.
    doc.noters = (await notersForDoc(doc)).map((h) => h.display_name);
    // A liquidation's items each need a COGS account before it can be noted; AP assigns them.
    doc.needs_cogs = AP_NOTED_TYPES.includes(doc.type);
    doc.cogs_missing = doc.needs_cogs ? doc.items.filter((i) => !i.cogs_account_id).length : 0;
    // While it waits to be noted, whoever notes it (AP); once noted or approved, AP or a System Admin,
    // until it is posted (cogsEditBlock -- a line already on a Vendor Bill stays as it is).
    // Approved: a System Admin only (asked 2026-10-19).
    doc.can_set_cogs = doc.needs_cogs && (doc.status === 'submitted'
      ? note.allowed
      : (['noted', 'approved'].includes(doc.status) && !(await cogsEditBlock(doc, null))
        && ((await isSystemAdmin(req.user.id)) || (doc.status === 'noted' && (await isAccountsPayable(req.user.id))))));
    // The entry its Vendor Bill or Journal will post (lib/glImpact.js computeLiquidationGl), shown as
    // it stands now. The liquidation itself posts nothing (2026-10-09): once approved, Accounts
    // Payable raises a Vendor Bill or a Journal from it, and that is what reaches the books.
    if (doc.needs_cogs) doc.gl_impact = await computeLiquidationGl(doc, doc.items);
    // A Request for Payment is billed too, by Vendor Bill only (2026-10-12): the same split by item,
    // no Journal, and no GL Impact of its own -- its items carry no accounts; Accounting picks them on
    // the bill.
    doc.billable = BILLABLE_FORM_TYPES.includes(doc.type);
    if (doc.billable) {
      // Its Vendor Bills -- one or several, each item on one (2026-10-12) -- or its Journal.
      const billing = await liquidationBilling(pool, doc.id);
      doc.vendor_bills = billing.bills;
      doc.vendor_bill = billing.bills[0] || null;
      doc.journal = billing.journal;
      doc.gl_posts = billing.fullyPosted;
      doc.partly_billed = billing.bills.length > 0 && !billing.fullyPosted;
      doc.billed_items = Object.fromEntries(billing.billOfItem);
      // Related Records (2026-10-12): every Vendor Bill and Journal raised from it, cancelled and
      // voided ones too, so the history shows.
      const [rvb] = await pool.query(
        `SELECT 'Vendor Bill' AS type, vb.id, vb.bill_no AS doc_no, vb.date_created, vb.status, vb.gross_amount AS amount, s.name AS party
           FROM vendor_bills vb LEFT JOIN suppliers s ON s.id = vb.supplier_id
          WHERE vb.form_request_id = ? ORDER BY vb.id`, [doc.id]);
      const [rj] = await pool.query(
        `SELECT 'Journal' AS type, j.id, j.journal_no AS doc_no, j.date_created, j.status, j.total_debit AS amount, NULL AS party
           FROM journals j WHERE j.form_request_id = ? ORDER BY j.id`, [doc.id]);
      doc.related_records = [...rvb, ...rj];
      if (doc.status === 'approved' && !doc.gl_posts) {
        // Create Vendor Bill's vendor, matched by name among the suppliers: for a Request for Payment
        // its Payable To; for a liquidation the filer (employees who liquidate are set up as
        // suppliers to be paid).
        const names = doc.type === 'payment'
          ? [doc.detail?.payable_to || '', doc.detail?.payable_to || '']
          : [doc.owner_name || '', doc.name || ''];
        const [[sup]] = await pool.query(
          'SELECT id FROM suppliers WHERE is_active = 1 AND LOWER(TRIM(name)) IN (LOWER(TRIM(?)), LOWER(TRIM(?))) LIMIT 1',
          names);
        doc.vendor_bill_supplier_id = sup ? sup.id : null;
        // Create Journal's Employee on each line: the filer's own employee record, else by name.
        const [[emp]] = await pool.query(
          `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name FROM employees e
            WHERE e.id = (SELECT employee_id FROM users WHERE id = ?)
               OR LOWER(TRIM(CONCAT(e.first_name, ' ', e.last_name))) IN (LOWER(TRIM(?)), LOWER(TRIM(?)))
            ORDER BY e.id = (SELECT employee_id FROM users WHERE id = ?) DESC LIMIT 1`,
          [doc.user_id, doc.owner_name || '', doc.name || '', doc.user_id]);
        doc.journal_employee = emp || null;
      }
    }

    // Employee Gate Pass: may this viewer record the guard's Time OUT / Time IN?
    if (doc.type === 'gate_pass') {
      doc.can_record_gate_time = (await userCan(req.user.id, GUARD_ROUTE, 'can_edit')) || (await isSystemAdmin(req.user.id));
    }
    // A Fund Transfer Request is posted by a Check Voucher or a Fund Transfer Voucher raised from it
    // once approved (2026-10-14; lib/fundTransferPosting.js) -- one, or several covering its total.
    if (doc.type === 'fund_transfer') {
      const p = await fundTransferRequestPosting(pool, doc.id);
      doc.vouchers = p.vouchers;
      doc.voucher_posted = p.posted;
      doc.voucher_remaining = p.remaining;
      doc.vouchers_post = p.fullyPosted;
      doc.related_records = p.vouchers;
      if (doc.status === 'approved' && !p.fullyPosted) {
        // Create Check Voucher's payee: the Payable To, matched by name among the suppliers.
        const [[sup]] = await pool.query(
          'SELECT id, name FROM suppliers WHERE is_active = 1 AND LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1', [doc.detail?.payable_to || '']);
        doc.voucher_supplier = sup || null;
      }
    }

    const appr = await mayApprove(req.user.id, doc);
    doc.can_approve = appr.eligible;
    // A business trip names its approvers -- the requestor's supervisor(s) -- and is noted first.
    if (doc.type === 'business_trip') {
      doc.leave_approvers = appr.approvers.map((a) => a.display_name);
      doc.leave_needs_note = true;
    }
    // A fuel request names its tagged approvers, and is never waiting on a note (as a leave with none).
    if (doc.type === 'fuel') {
      doc.leave_approvers = appr.approvers.map((a) => a.display_name);
      doc.leave_needs_note = false;
      doc.noters = [];
    }
    // A leave says who notes and who approves it, by the filer's reporting line.
    if (LEAVE_ROUTED.includes(doc.type)) {
      doc.leave_approvers = appr.approvers.map((a) => a.display_name);
      doc.leave_needs_note = appr.noters.length > 0;
      doc.noters = appr.noters.map((a) => a.display_name);
    }
    doc.can_reject = await mayReject(req.user.id, doc);
    if (doc.type === 'overtime') {
      // Approved by department heads, not the Forms Approval page (see overtimeApproval).
      const appr = await overtimeApproval(req.user.id, doc, doc.detail);
      doc.can_approve = false;
      doc.can_ot_approve = appr.allowed;
      doc.ot_approvers = appr.approvers.map((a) => a.display_name);
      doc.ot_approve_blocked_reason = appr.allowed ? null : appr.reason;
      doc.can_ot_respond = !!doc.detail && !doc.detail.for_self && doc.status === 'approved'
        && Number(doc.detail.target_user_id) === Number(req.user.id);
      // Confirm the ACTUAL time (2026-10-20): the filer, once it is final -- approved (for themself) or
      // accepted (for someone else) -- and not yet confirmed.
      const otRule = doc.detail ? await otConfirmRule(doc, doc.detail) : { confirmers: [] };
      doc.ot_confirmers = otRule.confirmers.map((c) => c.display_name);
      doc.ot_confirm_by_design_supervisor = !!otRule.byDesignSupervisor;
      doc.can_ot_confirm = !!doc.detail && otRule.confirmers.some((c) => Number(c.id) === Number(req.user.id))
        && !doc.detail.ot_confirmed_at
        && doc.status === (doc.detail.for_self ? 'approved' : 'accepted') && ('actual_hours' in doc.detail);
    }
    return res.json(doc);
  } catch (err) { return next(err); }
});

/* -------------------------------------------------------------------------- */
/* Creating                                                                    */
/* -------------------------------------------------------------------------- */

// Writes the side table for whichever type this is, and returns the computed totals so the caller
// can report them. Shared by create and update so the two cannot drift apart.
async function writeDetail(conn, docId, type, body, items, ownerId = null) {
  if (type === 'overtime') {
    const forSelf = body.ot_for_self === true || body.ot_for_self === 'true' || body.ot_for_self === 1 || body.ot_for_self === '1';
    const targetUserId = forSelf ? ownerId : Number(body.ot_target_user_id);
    const from = time(body.ot_time_from);
    const to = time(body.ot_time_to);
    // Hours from the two times; past midnight (22:00 -> 02:00) counts on into the next day.
    const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
    let span = mins(to) - mins(from);
    if (span <= 0) span += 24 * 60;
    await conn.query(
      `INSERT INTO form_overtime_details
         (form_request_id, for_self, target_user_id, target_department_id, ot_date, time_from, time_to, hours, purpose, reference_no)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [docId, forSelf ? 1 : 0, targetUserId, await userDepartmentId(conn, targetUserId), date(body.ot_date), from, to,
        Number((span / 60).toFixed(2)), trunc(body.ot_purpose, 4000), trunc(body.ot_reference_no, 100)],
    );
    return {};
  }
  if (type === 'liquidation' || type === 'revolving_fund') {
    const table = type === 'liquidation' ? 'form_liquidation_details' : 'form_revolving_fund_details';
    const t = totals(items, body.starting_balance);
    const cols = {
      form_request_id: docId,
      week_no: trunc(body.week_no, 50),
      date_from: date(body.date_from),
      date_to: date(body.date_to),
      cash_advance_amount: num(body.cash_advance_amount),
      cash_advance_date: date(body.cash_advance_date),
      previous_balance: num(body.previous_balance),
      starting_balance: num(body.starting_balance),
      reimbursement_amount: t.reimbursement_amount,
      ending_balance: t.ending_balance,
    };
    // form_no is on the liquidation only -- it is the pre-printed serial on that pad.
    if (type === 'liquidation') cols.form_no = trunc(body.form_no, 50);
    const keys = Object.keys(cols);
    await conn.query(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      keys.map((k) => cols[k]),
    );
    return t;
  }

  if (PAYMENT_TYPES.includes(type)) {
    const total = Number(items.reduce((s, r) => s + Number(r.amount || 0), 0).toFixed(2));
    const banks = type === 'fund_transfer';
    // The form's own From / To: the one bank all its lines share, else blank -- each line says its own.
    const shared = (k) => {
      const ids = [...new Set(items.map((it) => it[k]).filter(Boolean))];
      return ids.length === 1 ? ids[0] : null;
    };
    await conn.query(
      `INSERT INTO form_payment_details (form_request_id, payable_to, address, doc_date, total_amount, from_account_id, to_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [docId, trunc(body.payable_to, 255), trunc(body.address, 255), date(body.date ?? body.doc_date), total,
        banks ? shared('from_account_id') : null, banks ? shared('to_account_id') : null],
    );
    return { total_amount: total };
  }

  if (MEMBER_FORMS[type]) {
    await conn.query('INSERT INTO form_member_details (form_request_id, enrollment_for, letter_date) VALUES (?, ?, ?)',
      [docId, type === 'hmo_enrollment' ? (trunc(body.enrollment_for, 120) || 'HEALTH INSURANCE') : null, type === 'bpi_deletion' ? date(body.letter_date) : null]);
    const fields = MEMBER_FORMS[type].fields;
    let n = 0;
    for (const l of memberLines(type, body)) {
      n += 1;
      await conn.query(
        `INSERT INTO form_member_lines (form_request_id, line_no, ${fields.join(', ')}) VALUES (?, ?, ${fields.map(() => '?').join(', ')})`,
        [docId, n, ...fields.map((f) => l[f])]);
    }
    return {};
  }

  if (type === 'gate_pass') {
    await conn.query(
      `INSERT INTO form_gate_pass_details (form_request_id, location_id, pass_date, destination, purpose)
       VALUES (?, ?, ?, ?, ?)`,
      [docId, Number(body.gp_location_id) || null, date(body.gp_date), trunc(body.gp_destination, 255), trunc(body.gp_purpose, 4000)]);
    const lines = (Array.isArray(body.gp_items) ? body.gp_items : []).filter((it) => trunc(it && it.description, 500)).slice(0, MAX_GATE_ITEMS);
    let n = 0;
    for (const it of lines) {
      n += 1;
      await conn.query('INSERT INTO form_gate_pass_items (form_request_id, line_no, description, department) VALUES (?, ?, ?, ?)',
        [docId, n, trunc(it.description, 500), trunc(it.department, 150)]);
    }
    return {};
  }

  if (type === 'fuel') {
    const liters = num(body.fuel_liters);
    const price = num(body.fuel_price_per_liter);
    const amount = num(body.fuel_amount) ?? (price != null && liters != null ? Number((price * liters).toFixed(2)) : null);
    await conn.query(
      `INSERT INTO form_fuel_details
         (form_request_id, fuel_date, vehicle_asset_id, vehicle_label, liters, price_per_liter, amount, odometer_km, station, purpose)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [docId, date(body.fuel_date), Number(body.fuel_vehicle_asset_id) || null,
        Number(body.fuel_vehicle_asset_id) ? null : trunc(body.fuel_vehicle_label, 120),
        liters, price, amount, num(body.fuel_odometer_km), trunc(body.fuel_station, 120), trunc(body.fuel_purpose, 4000)],
    );
    return {};
  }

  if (type === 'undertime') {
    const shiftEnd = time(body.ut_shift_end);
    const timeOut = time(body.ut_time_out);
    await conn.query(
      `INSERT INTO form_undertime_details (form_request_id, ut_date, shift_end, time_out, minutes, reason)
       VALUES (?,?,?,?,?,?)`,
      [docId, date(body.ut_date), shiftEnd, timeOut, undertimeMinutes(timeOut, shiftEnd), trunc(body.ut_reason, 4000)],
    );
    return {};
  }

  if (type === 'leave') {
    const leaveType = LEAVE_TYPES.includes(body.leave_type) ? body.leave_type : 'others';
    const from = date(body.leave_date_from);
    const to = date(body.leave_date_to) || from;
    const part = from === to && DAY_PARTS.includes(body.leave_day_part) ? body.leave_day_part : 'whole';
    await conn.query(
      `INSERT INTO form_leave_details
         (form_request_id, leave_type, leave_type_other, date_from, date_to, day_part, days, reason, contact_while_on_leave)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [docId, leaveType, leaveType === 'others' ? trunc(body.leave_type_other, 255) : null, from, to, part,
        leaveDays(from, to, part), trunc(body.leave_reason, 4000), trunc(body.leave_contact, 255)],
    );
    return {};
  }

  if (type === 'attendance_adjustment') {
    const reason = ADJ_REASONS.includes(body.reason) ? body.reason : 'others';
    await conn.query(
      `INSERT INTO form_attendance_adjustment_details
         (form_request_id, adjustment_date, am_in, am_out, pm_in, pm_out, ot_in, ot_out, reason, reason_other)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [docId, date(body.adjustment_date), ...ADJ_TIMES.map((k) => time(body[k])), reason,
        reason === 'others' ? trunc(body.reason_other, 255) : null],
    );
    return {};
  }

  // business_trip
  await conn.query(
    `INSERT INTO form_business_trip_details
       (form_request_id, driver_name, vehicle_plate_no, speedometer_begin, speedometer_end,
        total_mileage_km, trip_date, time_out, time_in, purpose, checked_by, noted_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [docId, trunc(body.driver_name, 255), trunc(body.vehicle_plate_no, 255),
      trunc(body.speedometer_begin, 255), trunc(body.speedometer_end, 255),
      num(body.total_mileage_km), date(body.trip_date), time(body.time_out), time(body.time_in),
      trunc(body.purpose, 4000), trunc(body.checked_by, 255), trunc(body.noted_by, 255)],
  );
  return {};
}

// From and To on a Fund Transfer Request Form must be Bank accounts in the chart of accounts -- the only
// ones the picker offers, checked here so a hand-made request cannot name any other account.
// Every line's banks, since a form may move money between several (2026-10-13).
async function badBanks(type, body, items = []) {
  if (type !== 'fund_transfer') return null;
  const ids = [...new Set(items.flatMap((it) => [it.from_account_id, it.to_account_id]).filter(Boolean))];
  if (!ids.length) return null; // validate() has already said what is missing
  const [rows] = await pool.query(`SELECT x.id FROM (${BANK_ACCOUNTS_SQL}) x WHERE x.id IN (?)`, [ids]);
  return rows.length === ids.length ? null : 'From and To must all be bank accounts under Cash in Bank.';
}

// Validation that differs by type. Returns an error string, or null when the body is good.
function validate(type, body, items) {
  if (PAYMENT_TYPES.includes(type) && !trunc(body.payable_to, 255)) return 'Payable To is required.';
  if (type === 'fund_transfer') {
    for (const it of items) {
      const what = it.particulars ? `Line "${it.particulars}"` : 'Every line';
      if (!it.from_account_id) return `${what}: choose the bank the funds come From.`;
      if (!it.to_account_id) return `${what}: choose the bank the funds go To.`;
      if (it.from_account_id === it.to_account_id) return `${what}: From and To must be different banks.`;
    }
  }
  if (type === 'business_trip') {
    if (!trunc(body.driver_name, 255)) return 'Driver name is required.';
    if (!trunc(body.vehicle_plate_no, 255)) return 'Vehicle plate number is required.';
    if (!date(body.trip_date)) return 'Trip date is required.';
  }
  if (type === 'attendance_adjustment') {
    if (!date(body.adjustment_date)) return 'The date being adjusted is required.';
    if (!ADJ_TIMES.some((k) => time(body[k]))) return 'Enter at least one time to adjust (AM / PM / OT, In or Out).';
    if (!ADJ_REASONS.includes(body.reason)) return 'Choose the reason: Field Work, Business Trip or Others.';
    if (body.reason === 'others' && !trunc(body.reason_other, 255)) return 'Say what the other reason is (e.g. biometric error).';
  }
  if (MEMBER_FORMS[type]) {
    const lines = memberLines(type, body);
    if (!lines.length) return 'Add at least one member.';
    const LABEL = { member_type: 'P / D', family_name: 'Family Name', first_name: 'First Name', full_name: 'Name', reason: 'Reason for the Removal', bank_account_no: 'BPI Account Number' };
    for (let i = 0; i < lines.length; i += 1) {
      const miss = MEMBER_FORMS[type].required.filter((f) => !lines[i][f]);
      if (miss.length) return `Line ${i + 1}: ${miss.map((f) => LABEL[f] || f).join(', ')} required.`;
      if (lines[i].member_type && !['P', 'D'].includes(lines[i].member_type)) return `Line ${i + 1}: P / D must be P (principal) or D (dependent).`;
    }
  }
  if (type === 'gate_pass') {
    if (!date(body.gp_date)) return 'The date of the gate pass is required -- it is valid only on that day.';
    if (!trunc(body.gp_destination, 255)) return 'Say where you are going (Destination).';
    if (!trunc(body.name, 255)) return 'Name of Personnel is required.';
    if (!trunc(body.gp_purpose, 4000)) return 'Say the purpose of going out.';
  }
  if (type === 'fuel') {
    if (!date(body.fuel_date)) return 'The date is required.';
    if (!(Number(body.fuel_liters) > 0)) return 'Enter how many litres.';
    if (!Number(body.fuel_vehicle_asset_id) && !trunc(body.fuel_vehicle_label, 120)) return 'Choose the vehicle (or type it).';
    if (!trunc(body.fuel_purpose, 4000)) return 'Say what the fuel is for.';
  }
  if (type === 'undertime') {
    if (!date(body.ut_date)) return 'The date of the undertime is required.';
    if (!time(body.ut_shift_end)) return 'Enter your scheduled time out.';
    if (!time(body.ut_time_out)) return 'Enter the time you will leave.';
    if (!(undertimeMinutes(time(body.ut_time_out), time(body.ut_shift_end)) > 0)) return 'The time you leave has to be before your scheduled time out.';
    if (!trunc(body.ut_reason, 4000)) return 'Say why you are leaving early.';
  }
  if (type === 'leave') {
    if (!LEAVE_TYPES.includes(body.leave_type)) return 'Choose the type of leave.';
    if (body.leave_type === 'others' && !trunc(body.leave_type_other, 255)) return 'Say what kind of leave this is.';
    const from = date(body.leave_date_from);
    const to = date(body.leave_date_to) || from;
    if (!from) return 'The first day of leave is required.';
    if (to < from) return 'The last day of leave cannot be before the first.';
    const part = from === to && DAY_PARTS.includes(body.leave_day_part) ? body.leave_day_part : 'whole';
    if (!leaveDays(from, to, part)) return 'Those dates are only Sundays -- there is no working day to take leave on.';
    if (!trunc(body.leave_reason, 4000)) return 'Say why you are taking leave.';
  }
  if (type === 'overtime') {
    const forSelf = body.ot_for_self === true || body.ot_for_self === 'true' || body.ot_for_self === 1 || body.ot_for_self === '1';
    if (!forSelf && !Number(body.ot_target_user_id)) return 'Choose who the overtime is for.';
    if (!date(body.ot_date)) return 'The overtime date is required.';
    if (!time(body.ot_time_from) || !time(body.ot_time_to)) return 'Enter the overtime From and To times.';
    if (time(body.ot_time_from) === time(body.ot_time_to)) return 'From and To cannot be the same time.';
    if (!trunc(body.ot_purpose, 4000)) return 'Say what the overtime is for.';
  }
  if (!NO_ITEM_TYPES.includes(type) && items.length === 0) return 'Add at least one line.';
  return null;
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const { type } = req.body;
  if (badType(type)) return res.status(400).json({ error: 'Choose which form this is.' });

  const parsed = readItems(req.body, { required: !NO_ITEM_TYPES.includes(type) });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const items = parsed.items;

  const problem = validate(type, req.body, items) || await badBanks(type, req.body, items);
  if (problem) return res.status(400).json({ error: problem });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // A form starts as a DRAFT even though the button says Save: nothing reaches an approver until
    // its owner submits it, which is a second, deliberate action.
    // The department is stored twice on purpose: the NAME is what prints and is frozen, the ID is
    // the live link that says whose head has to note it. See db/add-form-department-id.js.
    const departmentName = trunc(req.body.department, 255);
    const departmentId = await resolveDepartmentId(conn, departmentName);

    const { id, no } = await insertNumbered(conn, {
      table: 'form_requests', column: 'request_no', prefix: 'REQ-',
      run: (docNo) => conn.query(
        `INSERT INTO form_requests (request_no, type, user_id, department, department_id, name, remarks, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
        [docNo, type, req.user.id, departmentName, departmentId, trunc(req.body.name, 255), trunc(req.body.remarks, 2000)],
      ),
    });

    for (const it of items) {
      await conn.query(
        'INSERT INTO form_request_items (form_request_id, item_date, particulars, amount, from_account_id, to_account_id) VALUES (?, ?, ?, ?, ?, ?)',
        [id, it.item_date, it.particulars, it.amount, type === 'fund_transfer' ? it.from_account_id : null, type === 'fund_transfer' ? it.to_account_id : null],
      );
    }

    await writeDetail(conn, id, type, req.body, items, req.user.id);
    await logFormAudit(conn, id, req.user.id, 'Created');

    if (type === 'liquidation') {
      const chosen = (Array.isArray(req.body.purposes) ? req.body.purposes : []).filter((p) => PURPOSES.includes(p));
      for (const p of chosen) {
        await conn.query(
          'INSERT INTO form_liquidation_purposes (form_request_id, purpose, other_text) VALUES (?, ?, ?)',
          [id, p, p === 'others' ? trunc(req.body.purpose_other_text, 255) : null],
        );
      }
    }

    await conn.commit();
    return res.status(201).json({ id, request_no: no });
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

/* -------------------------------------------------------------------------- */
/* Editing                                                                     */
/* -------------------------------------------------------------------------- */

// After the owner revises a REJECTED form it goes back where it came from: to NOTED if it had been
// noted, otherwise to SUBMITTED. The rejection is cleared along with the per-line remarks, because
// they describe a version that no longer exists.
//
// This is why noted_at/noted_by are not wiped on rejection -- they are the memory this reads.
async function restoreAfterRevision(conn, doc) {
  if (doc.status !== 'rejected') return doc.status;
  // A revised LIQUIDATION goes back to AP (SUBMITTED) whatever it was: its items are re-saved
  // without their COGS accounts, and AP must assign those again before it can be noted.
  const backToNoted = !!(doc.noted_at && doc.noted_by) && !AP_NOTED_TYPES.includes(doc.type);
  await conn.query(
    `UPDATE form_requests
        SET status = ?, submitted_at = COALESCE(submitted_at, NOW()),
            approved_at = NULL, approved_by = NULL,
            rejected_at = NULL, rejected_by = NULL, rejection_reason = NULL
      WHERE id = ?`,
    [backToNoted ? 'noted' : 'submitted', doc.id],
  );
  await conn.query('UPDATE form_request_items SET rejection_remark = NULL WHERE form_request_id = ?', [doc.id]);
  return backToNoted ? 'noted' : 'submitted';
}

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[doc]] = await conn.query('SELECT * FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    // A System Admin may edit any form, whoever filed it and whatever its status (asked 2026-10-09);
    // the edit is recorded in its System Information like any other.
    const admin = await isSystemAdmin(req.user.id);
    if (!admin && doc.user_id !== req.user.id) return res.status(403).json({ error: 'Only the person who filed this form can edit it.' });
    // Editing an approved form would change a document somebody has already signed off. A
    // SUBMITTED one is still editable (asked 2026-10-07) -- nobody has acted on it yet -- and stays
    // submitted; once it is noted or approved it is locked -- except to a System Admin.
    if (!admin && !EDITABLE_STATUSES.includes(doc.status)) {
      return res.status(409).json({ error: `A ${doc.status} form cannot be edited.` });
    }

    const parsed = readItems(req.body, { required: !NO_ITEM_TYPES.includes(doc.type) });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const items = parsed.items;

    const problem = validate(doc.type, req.body, items) || await badBanks(doc.type, req.body, items);
    if (problem) return res.status(400).json({ error: problem });

    await conn.beginTransaction();

    const departmentName = trunc(req.body.department, 255);
    const [[{ oldTotal }]] = await conn.query(
      'SELECT COALESCE(SUM(amount), 0) AS oldTotal FROM form_request_items WHERE form_request_id = ?', [doc.id]);
    const changes = [
      ['Department', doc.department, departmentName],
      ['Name', doc.name, trunc(req.body.name, 255)],
      ['Remarks', doc.remarks, trunc(req.body.remarks, 2000)],
      ['Total Amount', Number(oldTotal).toFixed(2), items.reduce((t, it) => t + Number(it.amount || 0), 0).toFixed(2)],
    ].filter(([, a, b]) => String(a ?? '') !== String(b ?? ''));
    for (const [field, a, b] of changes) await logFormAudit(conn, doc.id, req.user.id, 'Updated', field, a || null, b || null);
    if (!changes.length) await logFormAudit(conn, doc.id, req.user.id, 'Updated', 'Details');
    await conn.query(
      'UPDATE form_requests SET department = ?, department_id = ?, name = ?, remarks = ?, updated_at = NOW() WHERE id = ?',
      [departmentName, await resolveDepartmentId(conn, departmentName), trunc(req.body.name, 255), trunc(req.body.remarks, 2000), doc.id],
    );

    // Lines are replaced wholesale rather than diffed. They carry nothing worth preserving across
    // an edit -- no id is referenced anywhere else, and the rejection remarks against them are
    // being cleared by this very revision.
    // A submitted liquidation can be edited now (2026-10-07), and Accounts Payable may already have
    // given some lines their COGS account. A line that comes back unchanged -- same date,
    // particulars and amount -- keeps the account it had, so an edit elsewhere does not undo AP's work.
    const [oldItems] = await conn.query(
      'SELECT item_date, particulars, amount, cogs_account_id FROM form_request_items WHERE form_request_id = ? AND cogs_account_id IS NOT NULL',
      [doc.id]);
    const sameLine = (o, it) => String(o.item_date ? String(o.item_date instanceof Date ? o.item_date.toISOString() : o.item_date).slice(0, 10) : '')
        === String(it.item_date || '').slice(0, 10)
      && String(o.particulars || '') === String(it.particulars || '')
      && Math.abs(Number(o.amount || 0) - Number(it.amount || 0)) < 0.005;
    await conn.query('DELETE FROM form_request_items WHERE form_request_id = ?', [doc.id]);
    for (const it of items) {
      const kept = oldItems.findIndex((o) => sameLine(o, it));
      const cogs = kept >= 0 ? oldItems.splice(kept, 1)[0].cogs_account_id : null;
      await conn.query(
        'INSERT INTO form_request_items (form_request_id, item_date, particulars, amount, cogs_account_id, from_account_id, to_account_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [doc.id, it.item_date, it.particulars, it.amount, cogs,
          doc.type === 'fund_transfer' ? it.from_account_id : null, doc.type === 'fund_transfer' ? it.to_account_id : null],
      );
    }

    const detailTable = {
      liquidation: 'form_liquidation_details',
      payment: 'form_payment_details',
      fund_transfer: 'form_payment_details',
      revolving_fund: 'form_revolving_fund_details',
      business_trip: 'form_business_trip_details',
      attendance_adjustment: 'form_attendance_adjustment_details',
      overtime: 'form_overtime_details',
      leave: 'form_leave_details',
      undertime: 'form_undertime_details',
      fuel: 'form_fuel_details',
      gate_pass: 'form_gate_pass_details',
      hmo_enrollment: 'form_member_details',
      hmo_deletion: 'form_member_details',
      bpi_deletion: 'form_member_details',
    }[doc.type];
    await conn.query(`DELETE FROM ${detailTable} WHERE form_request_id = ?`, [doc.id]);
    if (doc.type === 'gate_pass') await conn.query('DELETE FROM form_gate_pass_items WHERE form_request_id = ?', [doc.id]);
    if (MEMBER_FORMS[doc.type]) await conn.query('DELETE FROM form_member_lines WHERE form_request_id = ?', [doc.id]);
    await writeDetail(conn, doc.id, doc.type, req.body, items, doc.user_id);

    if (doc.type === 'liquidation') {
      await conn.query('DELETE FROM form_liquidation_purposes WHERE form_request_id = ?', [doc.id]);
      const chosen = (Array.isArray(req.body.purposes) ? req.body.purposes : []).filter((p) => PURPOSES.includes(p));
      for (const p of chosen) {
        await conn.query(
          'INSERT INTO form_liquidation_purposes (form_request_id, purpose, other_text) VALUES (?, ?, ?)',
          [doc.id, p, p === 'others' ? trunc(req.body.purpose_other_text, 255) : null],
        );
      }
    }

    const status = await restoreAfterRevision(conn, doc);
    if (status !== doc.status) await logFormAudit(conn, doc.id, req.user.id, 'Status Change', 'Status', STATUS_LABEL[doc.status], STATUS_LABEL[status]);
    await conn.commit();
    // A rejected form the owner has just revised is back in somebody's queue.
    if (doc.status === 'rejected') notifyFormStatus(doc.id, req.user.id);
    return res.json({ ok: true, status });
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[doc]] = await pool.query('SELECT id, user_id, status FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (doc.user_id !== req.user.id) return res.status(403).json({ error: 'Only the person who filed this form can discard it.' });
    // Once it has been sent for a decision it is part of somebody's queue, and deleting it would
    // remove a document an approver may already have acted on.
    if (doc.status !== 'draft') return res.status(409).json({ error: 'Only a draft can be discarded.' });

    // The side tables and lines go with it -- every one is ON DELETE CASCADE.
    await pool.query('DELETE FROM form_requests WHERE id = ?', [doc.id]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

/* -------------------------------------------------------------------------- */
/* Workflow                                                                    */
/* -------------------------------------------------------------------------- */

// Submitting is the owner's own act, which is why it is gated on can_add rather than on the
// approval page: filing a form and sending it are the same job.
router.post('/:id/submit', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const [[doc]] = await pool.query('SELECT id, user_id, status, type FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (doc.user_id !== req.user.id) return res.status(403).json({ error: 'Only the person who filed this form can submit it.' });
    if (doc.status !== 'draft') return res.status(409).json({ error: 'Only a draft can be submitted.' });
    // Fuel Request: not past the filer's monthly limit (see fuelUsage).
    if (doc.type === 'fuel') {
      const [[d]] = await pool.query('SELECT fuel_date, liters FROM form_fuel_details WHERE form_request_id = ?', [doc.id]);
      const fd = d && date(d.fuel_date instanceof Date ? d.fuel_date.toISOString() : d.fuel_date);
      const u = await fuelUsage(doc.user_id, fd, doc.id);
      if (u.has_limit && d && u.used + Number(d.liters) > u.limit + 0.0005) {
        return res.status(409).json({
          error: `This takes you past your fuel limit of ${u.limit} L for ${u.month}: ${u.used} L already requested, ${u.remaining} L left, and this asks for ${Number(d.liters)} L.`,
        });
      }
    }

    await pool.query(
      "UPDATE form_requests SET status = 'submitted', submitted_at = NOW(), updated_at = NOW() WHERE id = ?", [doc.id]);
    await logFormAudit(pool, doc.id, req.user.id, 'Status Change', 'Status', 'Draft', 'Submitted');
    notifyFormStatus(doc.id, req.user.id);
    return res.json({ ok: true, status: 'submitted' });
  } catch (err) { return next(err); }
});

// Noting. Deliberately NOT wrapped in requirePermission: who may note depends on the form's type
// and its department, which cannot be known before the form is loaded.
router.post('/:id/note', requireAuth, async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      'SELECT id, type, status, user_id, department_id, department FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const { allowed, reason } = await mayNote(req.user.id, doc);
    if (!allowed) return res.status(403).json({ error: reason });

    if (doc.status !== 'submitted') return res.status(409).json({ error: 'Only a submitted form can be noted.' });
    if (AP_NOTED_TYPES.includes(doc.type)) {
      const [[m]] = await pool.query(
        'SELECT COUNT(*) AS n FROM form_request_items WHERE form_request_id = ? AND cogs_account_id IS NULL', [doc.id]);
      if (Number(m.n)) {
        return res.status(409).json({ error: `Select an account for every item first -- ${m.n} item(s) still have none.` });
      }
    }

    await pool.query(
      "UPDATE form_requests SET status = 'noted', noted_at = NOW(), noted_by = ?, updated_at = NOW() WHERE id = ?",
      [req.user.id, doc.id]);
    await logFormAudit(pool, doc.id, req.user.id, 'Status Change', 'Status', 'Submitted', 'Noted');
    notifyFormStatus(doc.id, req.user.id);
    return res.json({ ok: true, status: 'noted' });
  } catch (err) { return next(err); }
});

// Employee Gate Pass: the guard on duty checks and releases it -- Time OUT as the employee leaves,
// Time IN on return (2026-10-14). Only an approved pass, Time OUT only on the date it is valid for,
// OUT before IN, each once. Edit on the Gate Pass (Security Guard) page, or a System Admin.
router.post('/:id/gate-pass/:which', requireAuth, async (req, res, next) => {
  try {
    if (!['time-out', 'time-in'].includes(req.params.which)) return res.status(404).json({ error: 'Not found' });
    if (!(await userCan(req.user.id, GUARD_ROUTE, 'can_edit')) && !(await isSystemAdmin(req.user.id))) {
      return res.status(403).json({ error: 'Only the security guard on duty records gate pass times.' });
    }
    const [[doc]] = await pool.query('SELECT id, type, status FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc || doc.type !== 'gate_pass') return res.status(404).json({ error: 'Gate pass not found.' });
    if (doc.status !== 'approved') return res.status(409).json({ error: 'This gate pass is not approved yet.' });
    const d = await gatePassDetail(doc.id);
    if (!d) return res.status(404).json({ error: 'Gate pass not found.' });
    const out = req.params.which === 'time-out';
    if (out) {
      if (d.time_out) return res.status(409).json({ error: 'Time OUT is already recorded.' });
      if (String(d.pass_date).slice(0, 10) !== todayPh()) {
        return res.status(409).json({ error: `This gate pass is valid only on ${String(d.pass_date).slice(0, 10)}.` });
      }
      await pool.query('UPDATE form_gate_pass_details SET time_out = UTC_TIMESTAMP(), time_out_by_user_id = ? WHERE form_request_id = ?', [req.user.id, doc.id]);
    } else {
      if (!d.time_out) return res.status(409).json({ error: 'Record Time OUT first.' });
      if (d.time_in) return res.status(409).json({ error: 'Time IN is already recorded.' });
      await pool.query('UPDATE form_gate_pass_details SET time_in = UTC_TIMESTAMP(), time_in_by_user_id = ? WHERE form_request_id = ?', [req.user.id, doc.id]);
    }
    await logFormAudit(pool, doc.id, req.user.id, 'Updated', out ? 'Time OUT' : 'Time IN', null, 'Recorded');
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// Who may approve is mayApprove's call, not a page gate: a department's ticked leave approvers need
// no grant on the Forms Approval page to approve that department's leave.
router.post('/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      'SELECT id, type, status, user_id, department, department_id FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (doc.type === 'overtime') return res.status(409).json({ error: "An overtime request is approved by the department head, from the request itself." });
    const appr = await mayApprove(req.user.id, doc);
    if (!appr.eligible) return res.status(403).json({ error: appr.reason });
    if ((LEAVE_ROUTED.includes(doc.type) || doc.type === 'fuel') && !appr.allowed) return res.status(409).json({ error: appr.reason || 'Not waiting on approval.' });

    // NOTING IS A GATE, not a step that can be skipped. The source allowed submitted -> approved
    // directly; here a form must be noted by its department's head first, so the head's sign-off
    // cannot be bypassed by whoever approves.
    //
    // The cost of that is real and deliberate: a form from a department with no head recorded has
    // nowhere to go, so the refusal names who is missing rather than just saying no.
    if (doc.status === 'submitted' && !LEAVE_ROUTED.includes(doc.type) && doc.type !== 'fuel') {
      const heads = await notersForDoc(doc);
      if (AP_NOTED_TYPES.includes(doc.type) && heads.length === 0) {
        return res.status(409).json({ error: 'This liquidation has to be noted by Accounts Payable first, and nobody is marked Accounts Payable.' });
      }
      if (DEPARTMENT_NOTED_TYPES.includes(doc.type) && heads.length === 0) {
        return res.status(409).json({
          error: `This has to be noted before it can be approved, and ${doc.department || 'its department'} has no head recorded to note it. Add one under that department's ticket approvers.`,
        });
      }
      return res.status(409).json({
        error: heads.length
          ? `This has to be noted first, by ${heads.map((h) => h.display_name).join(' or ')}.`
          : 'This has to be noted before it can be approved.',
      });
    }
    if (!LEAVE_ROUTED.includes(doc.type) && doc.type !== 'fuel' && doc.status !== 'noted') {
      return res.status(409).json({ error: 'Only a noted form can be approved.' });
    }

    await pool.query(
      "UPDATE form_requests SET status = 'approved', approved_at = NOW(), approved_by = ?, updated_at = NOW() WHERE id = ?",
      [req.user.id, doc.id]);
    // An approved Fuel Request for a Fleet vehicle is that vehicle's fuel log entry (Assets > Fleet).
    if (doc.type === 'fuel') {
      const [[d]] = await pool.query('SELECT * FROM form_fuel_details WHERE form_request_id = ?', [doc.id]);
      if (d && d.vehicle_asset_id && !d.fuel_log_id) {
        const [[emp]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [doc.user_id]);
        const [ins] = await pool.query(
          `INSERT INTO vehicle_fuel_logs (asset_id, fuel_date, odometer_km, liters, price_per_liter, amount, is_full_tank, station,
             driver_employee_id, receipt_no, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          [d.vehicle_asset_id, d.fuel_date, d.odometer_km, d.liters, d.price_per_liter, d.amount, d.station,
            emp?.employee_id || null, null, req.user.id]).catch((e) => { if (e.code === 'ER_NO_SUCH_TABLE') return [{}]; throw e; });
        if (ins.insertId) await pool.query('UPDATE form_fuel_details SET fuel_log_id = ? WHERE form_request_id = ?', [ins.insertId, doc.id]);
      }
    }
    await logFormAudit(pool, doc.id, req.user.id, 'Approved', 'Status', STATUS_LABEL[doc.status], 'Approved');
    notifyFormStatus(doc.id, req.user.id);
    return res.json({ ok: true, status: 'approved' });
  } catch (err) { return next(err); }
});

// Overtime approval -- by the department head whose step it is (overtimeApproval). For yourself it
// is the last step; for someone else the employee then accepts or declines.
router.post('/:id/ot-approve', requireAuth, async (req, res, next) => {
  try {
    const [[doc]] = await pool.query('SELECT id, type, status, department, department_id FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc || doc.type !== 'overtime') return res.status(404).json({ error: 'Not found' });
    const d = await overtimeDetail(doc.id);
    const appr = await overtimeApproval(req.user.id, doc, d);
    if (!appr.allowed) return res.status(doc.status === (d && d.for_self ? 'submitted' : 'noted') ? 403 : 409).json({ error: appr.reason || 'Not waiting on approval.' });
    await pool.query(
      "UPDATE form_requests SET status = 'approved', approved_at = NOW(), approved_by = ?, updated_at = NOW() WHERE id = ?",
      [req.user.id, doc.id]);
    await logFormAudit(pool, doc.id, req.user.id, 'Approved', 'Status', STATUS_LABEL[doc.status], 'Approved');
    notifyFormStatus(doc.id, req.user.id);
    return res.json({ ok: true, status: 'approved' });
  } catch (err) { return next(err); }
});

// The employee's answer to an approved overtime request filed for them: accept or decline.
router.post('/:id/ot-respond', requireAuth, async (req, res, next) => {
  try {
    const [[doc]] = await pool.query('SELECT id, type, status FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc || doc.type !== 'overtime') return res.status(404).json({ error: 'Not found' });
    const d = await overtimeDetail(doc.id);
    if (!d || d.for_self) return res.status(409).json({ error: 'An overtime request for yourself has nothing to accept.' });
    if (Number(d.target_user_id) !== Number(req.user.id)) return res.status(403).json({ error: 'Only the employee this overtime is for can answer it.' });
    if (doc.status !== 'approved') return res.status(409).json({ error: 'This overtime request is not waiting on your answer.' });
    const accept = req.body?.decision === 'accept';
    if (!accept && req.body?.decision !== 'decline') return res.status(400).json({ error: 'Accept or decline.' });
    const remark = trunc(req.body?.remark, 1000);
    if (!accept && !remark) return res.status(400).json({ error: 'Say why you are declining.' });
    const status = accept ? 'accepted' : 'declined';
    await pool.query("UPDATE form_requests SET status = ?, updated_at = NOW() WHERE id = ?", [status, doc.id]);
    await pool.query('UPDATE form_overtime_details SET responded_at = NOW(), response_remark = ? WHERE form_request_id = ?', [remark, doc.id]);
    await logFormAudit(pool, doc.id, req.user.id, 'Status Change', 'Status', 'Approved', STATUS_LABEL[status]);
    if (remark) await logFormAudit(pool, doc.id, req.user.id, 'Updated', 'Response', null, remark);
    notifyFormStatus(doc.id, req.user.id);
    return res.json({ ok: true, status });
  } catch (err) { return next(err); }
});

// Overtime: the ACTUAL time worked, confirmed by the person who filed it (asked 2026-10-20: requested for
// 4 hours, worked 3). Once final -- approved for yourself, accepted by the employee for someone else --
// and once only. db/add-ot-confirmation.js adds the columns.
const otHours = (from, to) => {
  const m = (t) => { const [h, mi] = String(t).split(':').map(Number); return h * 60 + (mi || 0); };
  if (!from || !to) return 0;
  let d = m(to) - m(from);
  if (d <= 0) d += 24 * 60; // past midnight counts on
  return Math.round((d / 60) * 100) / 100;
};
router.post('/:id/ot-confirm', requireAuth, async (req, res, next) => {
  try {
    const [[doc]] = await pool.query('SELECT id, type, status, user_id FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc || doc.type !== 'overtime') return res.status(404).json({ error: 'Not found' });
    const d = await overtimeDetail(doc.id);
    const rule = await otConfirmRule(doc, d);
    if (!rule.confirmers.some((c) => Number(c.id) === Number(req.user.id))) {
      return res.status(403).json({ error: rule.byDesignSupervisor
        ? "An artist's overtime is confirmed by the Design Supervisor."
        : 'Only the person who filed this overtime request confirms it.' });
    }
    if (!d || !('actual_hours' in d)) return res.status(409).json({ error: 'Overtime confirmation is not set up yet (run db/add-ot-confirmation.js).' });
    const finalStatus = d.for_self ? 'approved' : 'accepted';
    if (doc.status !== finalStatus) {
      return res.status(409).json({ error: d.for_self ? 'Only an approved overtime request can be confirmed.' : 'The employee has to accept this overtime request before it can be confirmed.' });
    }
    if (d.ot_confirmed_at) return res.status(409).json({ error: 'This overtime request is already confirmed.' });
    const t = (v) => (/^\d{1,2}:\d{2}/.test(String(v || '')) ? String(v).slice(0, 5) : null);
    const from = t(req.body?.actual_time_from);
    const to = t(req.body?.actual_time_to);
    if (!from || !to) return res.status(400).json({ error: 'Enter the actual time from and to.' });
    const hours = otHours(from, to);
    if (!(hours > 0)) return res.status(400).json({ error: 'The actual time from and to cannot be the same.' });
    await pool.query(
      `UPDATE form_overtime_details SET actual_time_from = ?, actual_time_to = ?, actual_hours = ?, ot_confirmed_at = NOW(), ot_confirmed_by_user_id = ?
        WHERE form_request_id = ?`, [from, to, hours, req.user.id, doc.id]);
    await logFormAudit(pool, doc.id, req.user.id, 'Updated', 'Actual Overtime',
      d.hours != null ? `${Number(d.hours).toFixed(2)} h filed` : null, `${from}-${to} (${hours.toFixed(2)} h actual)`);
    return res.json({ ok: true, actual_hours: hours });
  } catch (err) { return next(err); }
});

// Rejecting carries per-line remarks as well as a reason, so the owner is told WHICH expense is the
// problem rather than only that something is.
// Who may reject: an approver, at SUBMITTED or NOTED; and whoever may note the form (its department
// head, Accounts Payable for a liquidation), while it is waiting on them at SUBMITTED (2026-10-09)
// -- a head who cannot accept a request has to be able to send it back, not just leave it sitting.
async function mayReject(userId, doc) {
  if (!['submitted', 'noted'].includes(doc.status)) return false;
  // Overtime: whoever's step it is -- the noter at SUBMITTED (for someone else), the approving head
  // at SUBMITTED (for yourself) or NOTED (for someone else).
  if (doc.type === 'overtime') {
    const d = await overtimeDetail(doc.id);
    if ((await overtimeApproval(userId, doc, d)).allowed) return true;
    return doc.status === 'submitted' && (await mayNote(userId, doc)).allowed;
  }
  // The approver (for leave, by the filer's reporting line -- lib/leaveRoute.js).
  if ((await mayApprove(userId, doc)).eligible) return true;
  return doc.status === 'submitted' && (await mayNote(userId, doc)).allowed;
}

router.post('/:id/reject', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[doc]] = await conn.query('SELECT id, type, status, user_id, department_id, department FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!['submitted', 'noted'].includes(doc.status)) {
      return res.status(409).json({ error: 'Only a submitted or noted form can be rejected.' });
    }
    if (!(await mayReject(req.user.id, doc))) {
      return res.status(403).json({ error: 'You do not have permission to reject this form.' });
    }

    await conn.beginTransaction();
    // noted_at/noted_by are deliberately NOT cleared: they are how the form finds its way back to
    // NOTED once the owner has revised it.
    await conn.query(
      `UPDATE form_requests SET status = 'rejected', rejected_at = NOW(), rejected_by = ?,
              rejection_reason = ?, updated_at = NOW() WHERE id = ?`,
      [req.user.id, trunc(req.body.reason, 2000) || 'Rejected', doc.id],
    );
    await logFormAudit(conn, doc.id, req.user.id, 'Disapproved', 'Reason', null, trunc(req.body.reason, 2000) || 'Rejected');

    const remarks = req.body.line_remarks && typeof req.body.line_remarks === 'object' ? req.body.line_remarks : {};
    for (const [itemId, remark] of Object.entries(remarks)) {
      // Scoped to this form's own lines, so a remark cannot be written onto somebody else's form
      // by posting a stray id.
      await conn.query(
        'UPDATE form_request_items SET rejection_remark = ? WHERE id = ? AND form_request_id = ?',
        [trunc(remark, 2000), Number(itemId), doc.id],
      );
    }

    await conn.commit();
    notifyFormStatus(doc.id, req.user.id);
    return res.json({ ok: true, status: 'rejected' });
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

/* -------------------------------------------------------------------------- */
/* Printing                                                                    */
/* -------------------------------------------------------------------------- */

// A business trip prints once NOTED; everything else needs APPROVED. That asymmetry is the
// source's and it is deliberate -- the trip sheet goes out with the driver, and waiting on a final
// approval would mean the vehicle leaves without its paperwork.
// ---- Attachments (every form type, asked 2026-10-07) ----
//
// Whoever may see a form may attach to it -- its owner, and the head and approvers who have to
// rule on it and may want to add what they relied on. A file comes off only by the person who
// put it there, and only until the form is approved; a System Admin may always remove one. Once
// approved, what the approval was given against stays on the record.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

async function formForAttachments(id) {
  const [[doc]] = await pool.query('SELECT id, type, status, user_id, department_id, noted_by, approved_by, rejected_by FROM form_requests WHERE id = ?', [id]);
  return doc || null;
}

router.get('/:id/attachments', requireAuth, async (req, res, next) => {
  try {
    const doc = await formForAttachments(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!(await maySee(req.user.id, doc))) return res.status(403).json({ error: 'This form is not yours to view.' });
    const [rows] = await pool.query(
      `SELECT a.id, a.file_name, a.mime_type, a.size_bytes, a.created_at, a.uploaded_by_user_id,
              u.display_name AS uploaded_by_name
         FROM form_request_attachments a LEFT JOIN users u ON u.id = a.uploaded_by_user_id
        WHERE a.form_request_id = ? ORDER BY a.created_at DESC, a.id DESC`, [doc.id]);
    const admin = await isSystemAdmin(req.user.id);
    res.json(rows.map((r) => ({
      ...r,
      can_remove: admin || (Number(r.uploaded_by_user_id) === Number(req.user.id) && doc.status !== 'approved'),
    })));
  } catch (err) { next(err); }
});

router.post('/:id/attachments', requireAuth, async (req, res, next) => {
  try {
    const doc = await formForAttachments(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!(await maySee(req.user.id, doc))) return res.status(403).json({ error: 'This form is not yours to attach to.' });
    const { file_name: fileName, data, mime_type: mimeType } = req.body || {};
    if (!fileName || !data) return res.status(400).json({ error: 'file_name and data are required' });
    // A bare base64 string or a full data: URL, which is what the browser's FileReader gives.
    const buf = Buffer.from(String(data).includes(',') ? String(data).split(',').pop() : String(data), 'base64');
    if (!buf.length) return res.status(400).json({ error: 'The uploaded file is empty' });
    if (buf.length > MAX_ATTACHMENT_BYTES) return res.status(413).json({ error: 'Files must be 10MB or smaller' });
    // Any type is accepted; the browser's reported type is only used to serve the file back.
    const safeMime = /^[\w.+-]+\/[\w.+-]+$/.test(String(mimeType || '')) ? String(mimeType).slice(0, 100) : 'application/octet-stream';
    const [r] = await pool.query(
      `INSERT INTO form_request_attachments (form_request_id, file_name, mime_type, size_bytes, file_data, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [doc.id, String(fileName).slice(0, 255), safeMime, buf.length, buf, req.user.id]);
    await logFormAudit(pool, doc.id, req.user.id, 'Updated', 'Attachment', null, String(fileName).slice(0, 255));
    res.status(201).json({ id: r.insertId });
  } catch (err) { next(err); }
});

router.get('/:id/attachments/:attachmentId/file', requireAuth, async (req, res, next) => {
  try {
    const doc = await formForAttachments(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!(await maySee(req.user.id, doc))) return res.status(403).json({ error: 'This form is not yours to view.' });
    const [[row]] = await pool.query(
      'SELECT file_name, mime_type, file_data FROM form_request_attachments WHERE id = ? AND form_request_id = ?',
      [req.params.attachmentId, doc.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    // PDFs and images open in a tab; anything else downloads.
    const inline = /^(application\/pdf|image\/)/.test(row.mime_type || '');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${row.file_name.replace(/"/g, '')}"`);
    res.send(row.file_data);
  } catch (err) { next(err); }
});

router.delete('/:id/attachments/:attachmentId', requireAuth, async (req, res, next) => {
  try {
    const doc = await formForAttachments(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const [[att]] = await pool.query(
      'SELECT uploaded_by_user_id, file_name FROM form_request_attachments WHERE id = ? AND form_request_id = ?',
      [req.params.attachmentId, doc.id]);
    if (!att) return res.status(404).json({ error: 'Not found' });
    const own = Number(att.uploaded_by_user_id) === Number(req.user.id);
    if (!(await isSystemAdmin(req.user.id))) {
      if (!own) return res.status(403).json({ error: 'Only the person who attached this file can remove it.' });
      if (doc.status === 'approved') return res.status(409).json({ error: 'This form is approved -- its attachments stay as they were.' });
    }
    await pool.query('DELETE FROM form_request_attachments WHERE id = ? AND form_request_id = ?', [req.params.attachmentId, doc.id]);
    await logFormAudit(pool, doc.id, req.user.id, 'Updated', 'Attachment', att.file_name, null);
    res.status(204).send();
  } catch (err) { next(err); }
});

router.get('/:id/print', requireAuth, requirePermission(ROUTE, 'can_print'), async (req, res, next) => {
  try {
    const doc = await loadFull(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!(await maySee(req.user.id, doc))) return res.status(403).json({ error: 'This form is not yours to view.' });

    // An attendance adjustment prints once its superior has noted it, like the trip sheet.
    const printsWhenNoted = ['business_trip', 'attendance_adjustment'].includes(doc.type);
    const allowed = printsWhenNoted ? ['noted', 'approved'] : ['approved'];
    if (!allowed.includes(doc.status)) {
      return res.status(403).json({
        error: printsWhenNoted
          ? `${TYPE_LABELS[doc.type]} can be printed once it has been noted.`
          : 'Only an approved form can be printed.',
      });
    }

    doc.type_label = TYPE_LABELS[doc.type] || doc.type;

    // The three signatures, fetched HERE and nowhere else. They are a few KB of PNG each and only
    // the printed sheet has anywhere to put them -- loading them on every form view would put
    // three images through the wire to render a screen that shows none of them.
    //
    // Read from the user the WORKFLOW RECORDED -- owner, noted_by, approved_by -- not from whoever
    // is printing. The signature is drawn onto a decision that was already made and already
    // attributed; it never makes one. Where somebody has no signature on file the line stays blank
    // to be signed by hand, exactly as the form worked before.
    const signers = [doc.user_id, doc.noted_by, doc.approved_by].filter(Boolean);
    if (signers.length) {
      const [sigs] = await pool.query(
        'SELECT id, signature_data FROM users WHERE id IN (?) AND signature_data IS NOT NULL', [signers]);
      const byId = new Map(sigs.map((s) => [String(s.id), s.signature_data]));
      doc.owner_signature = byId.get(String(doc.user_id)) || null;
      doc.noted_signature = byId.get(String(doc.noted_by)) || null;
      doc.approved_signature = byId.get(String(doc.approved_by)) || null;
    }
    return res.json(doc);
  } catch (err) { return next(err); }
});

module.exports = router;
