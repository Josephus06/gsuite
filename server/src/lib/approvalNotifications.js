const pool = require('../db');
const { notersForDoc, DEPARTMENT_NOTED_TYPES, AP_NOTED_TYPES, notersFor } = require('./formNoters');
const { leaveRoute } = require('./leaveRoute');

// The bell for documents waiting on somebody's decision -- Purchase Orders and the request Forms.
// Until 2026-10-07 neither wrote a notification at all, so an approver only found a PO or a form
// by going to look for it. Each of these is called AFTER the action has committed, and a failure
// here is logged and swallowed: telling someone about a decision must never undo or block it.
//
// The actor is never notified about their own act, and nobody is told twice about one event.

async function insertFor(userIds, { type, title, message, relatedType, relatedId }, actorId) {
  const ids = [...new Set((userIds || []).map(Number).filter((id) => id && id !== Number(actorId)))];
  for (const userId of ids) {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, type, String(title).slice(0, 255), message ? String(message).slice(0, 500) : null, relatedType, relatedId],
    );
  }
}

async function usersWithPermission(route, action) {
  const [rows] = await pool.query(
    `SELECT DISTINCT u.id FROM user_page_permissions p
       JOIN pages pg ON pg.id = p.page_id
       JOIN users u ON u.id = p.user_id
      WHERE pg.route = ? AND p.${action} = 1 AND u.is_active = 1`,
    [route],
  );
  return rows.map((r) => r.id);
}

function safely(label, fn) {
  return fn().catch((err) => console.error(`[notifications] ${label}:`, err.message));
}

/* ---------------------------------------------------------------- Purchase Orders ---------- */

const PO_APPROVAL_THRESHOLD = 10000; // routes/purchaseOrders.js APPROVAL_THRESHOLD -- keep in step

// A PO has just entered a pending status. Who clears each tier is routes/purchaseOrders.js
// PUT /:id/approve:
//   pending_approval     a Purchasing Supervisor
//   pending_approval_gm  above the threshold, the General Manager; within it, the Purchasing
//                        Supervisors only -- a PO of 10,000 or less no longer goes to the GM, so the GM
//                        is not told about it (2026-10-14). PO3/PO4 enter this tier directly.
// PO3/PO4 (2026-10-19): the General Manager approves those whatever the amount, so the GM is told
// about every one -- routes/purchaseOrders.js GM_ONLY_TYPES.
const PO_GM_ONLY_TYPES = ['PO3', 'PO4'];
function notifyPoPending({ id, poNo, status, total, type }, actorId) {
  return safely(`PO ${poNo} ${status}`, async () => {
    // A General Manager is never told at the supervisor tier, even with the Purchasing Supervisor box
    // ticked (JIMMY WU has it, and still got PO-21055 for 630.00 -- 2026-10-14): anything that needs
    // the GM reaches them at the GM tier.
    const [sups] = await pool.query(
      "SELECT id FROM users WHERE is_purchasing_supervisor = 1 AND is_active = 1 AND (account_type IS NULL OR account_type <> 'General Manager')");
    let to = [];
    if (status === 'pending_approval') {
      to = sups.map((u) => u.id);
    } else if (status === 'pending_approval_gm') {
      if (Number(total) <= PO_APPROVAL_THRESHOLD && !PO_GM_ONLY_TYPES.includes(type)) {
        to = sups.map((u) => u.id);
      } else {
        const [gms] = await pool.query("SELECT id FROM users WHERE account_type = 'General Manager' AND is_active = 1");
        to = gms.map((u) => u.id);
      }
    }
    const forGm = status === 'pending_approval_gm' && (Number(total) > PO_APPROVAL_THRESHOLD || PO_GM_ONLY_TYPES.includes(type));
    await insertFor(to, {
      type: 'po_pending_approval',
      title: `${poNo} needs your approval`,
      message: `Purchase Order ${poNo} (${Number(total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) is ${forGm ? 'pending GM approval' : 'pending approval'}.`,
      relatedType: 'PurchaseOrder',
      relatedId: id,
    }, actorId);
  });
}

// Fully approved: the person who raised it can now send it to the supplier.
function notifyPoApproved({ id, poNo, createdBy }, actorId) {
  return safely(`PO ${poNo} approved`, () => insertFor([createdBy], {
    type: 'po_approved', title: `${poNo} was approved`, message: `Purchase Order ${poNo} is approved.`,
    relatedType: 'PurchaseOrder', relatedId: id,
  }, actorId));
}

/* ---------------------------------------------------------------- Forms --------------------- */

const FORM_LABEL = {
  liquidation: 'Liquidation', payment: 'Request for Payment', fund_transfer: 'Fund Transfer Request',
  business_trip: 'Business Trip', revolving_fund: 'Revolving Fund', attendance_adjustment: 'Attendance Adjustment',
  overtime: 'Overtime Request', leave: 'Leave Application', gate_pass: 'Employee Gate Pass', fuel: 'Fuel Request',
  hmo_enrollment: 'Life & Health - Enrollment', hmo_deletion: 'Life & Health - Deletion', bpi_deletion: 'BPI Deletion',
};

// A form has just changed status. Who acts next is routes/forms.js:
//   submitted  noted by Accounts Payable (liquidation), the department's heads (payment, fund
//              transfer, revolving fund, attendance adjustment), or whoever holds can_edit on the
//              approval page (business trip)
//   noted      approved by whoever holds can_approve on the approval page; the owner is told too
//   approved / rejected   the owner
function notifyFormStatus(formId, actorId) {
  return safely(`form ${formId}`, async () => {
    const [[doc]] = await pool.query(
      'SELECT id, request_no, type, user_id, department_id, department, status, rejection_reason FROM form_requests WHERE id = ?',
      [formId],
    );
    if (!doc) return;
    const what = `${FORM_LABEL[doc.type] || 'Form'} ${doc.request_no || ''}`.trim();
    const base = { relatedType: 'Form', relatedId: doc.id };

    // Overtime Request (2026-10-13) has its own chain -- see routes/forms.js.
    if (doc.type === 'overtime') {
      const [[d]] = await pool.query(
        `SELECT o.for_self, o.target_user_id, o.target_department_id, tu.display_name AS target_name, o.ot_date
           FROM form_overtime_details o LEFT JOIN users tu ON tu.id = o.target_user_id WHERE o.form_request_id = ?`, [doc.id]);
      if (!d) return;
      const forWhom = d.for_self ? '' : ` for ${d.target_name}`;
      const otWhat = `Overtime Request ${doc.request_no || ''}${forWhom}`.trim();
      const headsOf = async (deptId) => (await notersFor(deptId, pool, 'overtime')).map((u) => u.id);
      if (doc.status === 'submitted') {
        if (d.for_self) {
          await insertFor(await headsOf(doc.department_id), { ...base, type: 'form_pending_approval', title: `${otWhat} needs your approval`, message: `${otWhat} is waiting for your approval.` }, actorId);
        } else {
          await insertFor(await headsOf(doc.department_id), { ...base, type: 'form_pending_note', title: `${otWhat} needs your noting`, message: `${otWhat}${doc.department ? ` from ${doc.department}` : ''} is waiting to be noted.` }, actorId);
        }
      } else if (doc.status === 'noted') {
        await insertFor(await headsOf(d.target_department_id), { ...base, type: 'form_pending_approval', title: `${otWhat} needs your approval`, message: `${otWhat} has been noted and is waiting for your approval.` }, actorId);
        await insertFor([doc.user_id], { ...base, type: 'form_noted', title: `${otWhat} was noted`, message: `${otWhat} has been noted and is now waiting for approval.` }, actorId);
      } else if (doc.status === 'approved') {
        await insertFor([doc.user_id], { ...base, type: 'form_approved', title: `${otWhat} was approved`, message: d.for_self ? `${otWhat} is approved.` : `${otWhat} is approved and waiting for ${d.target_name} to accept.` }, actorId);
        if (!d.for_self) {
          await insertFor([d.target_user_id], { ...base, type: 'form_pending_approval', title: 'Overtime requested of you', message: `${otWhat}: please accept or decline.` }, actorId);
        }
      } else if (doc.status === 'accepted' || doc.status === 'declined') {
        await insertFor([doc.user_id], { ...base, type: doc.status === 'accepted' ? 'form_approved' : 'form_rejected', title: `${otWhat} was ${doc.status}`, message: `${d.target_name} ${doc.status} the overtime.` }, actorId);
      } else if (doc.status === 'rejected') {
        await insertFor([doc.user_id], { ...base, type: 'form_rejected', title: `${otWhat} was rejected`, message: doc.rejection_reason ? `Reason: ${doc.rejection_reason}` : `${otWhat} was rejected.` }, actorId);
      }
      return;
    }

    // Fuel Request (2026-10-19): no noting -- submitted goes straight to the tagged Fuel Approvers.
    if (doc.type === 'fuel' && doc.status === 'submitted') {
      const [rows] = await pool.query('SELECT id FROM users WHERE is_fuel_approver = 1 AND is_active = 1').catch(() => [[]]);
      await insertFor(rows.map((r) => r.id).filter((id) => Number(id) !== Number(doc.user_id)), {
        ...base, type: 'form_pending_approval', title: `${what} needs your approval`,
        message: `${what}${doc.department ? ` from ${doc.department}` : ''} is waiting for your approval.`,
      }, actorId);
      return;
    }

    // Leave Application (2026-10-19): by the filer's reporting line (lib/leaveRoute.js) -- submitted
    // goes to the supervisor who notes it, or straight to its approver when there is nobody to note;
    // noted goes to the approver. approvers: [] there means the Forms Approval approvers.
    if (doc.type === 'leave' && (doc.status === 'submitted' || doc.status === 'noted')) {
      const route = await leaveRoute(doc);
      const approverIds = async () => (route.approvers.length
        ? route.approvers.map((u) => u.id) : usersWithPermission('/forms/approval', 'can_approve'));
      const from = doc.department ? ` from ${doc.department}` : '';
      if (doc.status === 'submitted' && route.noters.length) {
        await insertFor(route.noters.map((u) => u.id), { ...base, type: 'form_pending_note', title: `${what} needs your noting`, message: `${what}${from} is waiting to be noted.` }, actorId);
      } else if (doc.status === 'submitted') {
        await insertFor(await approverIds(), { ...base, type: 'form_pending_approval', title: `${what} needs your approval`, message: `${what}${from} is waiting for your approval.` }, actorId);
      } else {
        await insertFor(await approverIds(), { ...base, type: 'form_pending_approval', title: `${what} needs your approval`, message: `${what} has been noted and is waiting for your approval.` }, actorId);
        await insertFor([doc.user_id], { ...base, type: 'form_noted', title: `${what} was noted`, message: `${what} has been noted and is now waiting for approval.` }, actorId);
      }
      return;
    }

    if (doc.status === 'submitted') {
      let to = (await notersForDoc(doc)).map((u) => u.id);
      if (!AP_NOTED_TYPES.includes(doc.type) && !DEPARTMENT_NOTED_TYPES.includes(doc.type)) to = await usersWithPermission('/forms/approval', 'can_edit');
      await insertFor(to, { ...base, type: 'form_pending_note', title: `${what} needs your noting`, message: `${what}${doc.department ? ` from ${doc.department}` : ''} is waiting to be noted.` }, actorId);
    } else if (doc.status === 'noted') {
      await insertFor(await usersWithPermission('/forms/approval', 'can_approve'), {
        ...base, type: 'form_pending_approval', title: `${what} needs your approval`, message: `${what} has been noted and is waiting for approval.`,
      }, actorId);
      await insertFor([doc.user_id], { ...base, type: 'form_noted', title: `${what} was noted`, message: `${what} has been noted and is now waiting for approval.` }, actorId);
    } else if (doc.status === 'approved') {
      await insertFor([doc.user_id], { ...base, type: 'form_approved', title: `${what} was approved`, message: `${what} is approved.` }, actorId);
    } else if (doc.status === 'rejected') {
      await insertFor([doc.user_id], {
        ...base, type: 'form_rejected', title: `${what} was rejected`, message: doc.rejection_reason ? `Reason: ${doc.rejection_reason}` : `${what} was rejected.`,
      }, actorId);
    }
  });
}

module.exports = { notifyPoPending, notifyPoApproved, notifyFormStatus, insertFor, usersWithPermission };
