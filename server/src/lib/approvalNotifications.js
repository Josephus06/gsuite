const pool = require('../db');
const { notersForDoc } = require('./formNoters');

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
//   pending_approval_gm  the General Manager; a Purchasing Supervisor too when it is within the
//                        threshold (PO3/PO4 enter this tier directly, whatever the amount)
function notifyPoPending({ id, poNo, status, total }, actorId) {
  return safely(`PO ${poNo} ${status}`, async () => {
    const [sups] = await pool.query('SELECT id FROM users WHERE is_purchasing_supervisor = 1 AND is_active = 1');
    let to = [];
    if (status === 'pending_approval') {
      to = sups.map((u) => u.id);
    } else if (status === 'pending_approval_gm') {
      const [gms] = await pool.query("SELECT id FROM users WHERE account_type = 'General Manager' AND is_active = 1");
      to = gms.map((u) => u.id);
      if (Number(total) <= PO_APPROVAL_THRESHOLD) to.push(...sups.map((u) => u.id));
    }
    await insertFor(to, {
      type: 'po_pending_approval',
      title: `${poNo} needs your approval`,
      message: `Purchase Order ${poNo} (${Number(total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) is ${status === 'pending_approval_gm' ? 'pending GM approval' : 'pending approval'}.`,
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
};

// A form has just changed status. Who acts next is routes/forms.js:
//   submitted  noted by Accounts Payable (liquidation), the department's heads (payment / fund
//              transfer), or whoever holds can_edit on the approval page (business trip, revolving fund)
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

    if (doc.status === 'submitted') {
      let to = (await notersForDoc(doc)).map((u) => u.id);
      if (!['liquidation', 'payment', 'fund_transfer'].includes(doc.type)) to = await usersWithPermission('/forms/approval', 'can_edit');
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

module.exports = { notifyPoPending, notifyPoApproved, notifyFormStatus };
