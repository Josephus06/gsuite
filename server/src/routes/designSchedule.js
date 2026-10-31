const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { notifyDesignSupervisors, notifyAssignedArtist } = require('../lib/designNotifications');
const { getSbuScope } = require('../lib/sbuGroups');
const { DESIGN_QUEUE_STATUS } = require('../lib/designSupervisorVisibility');

// Design > Design Schedule (2026-10-31). The SBU puts a JO / NSTDJO on the calendar, forwards it to
// the Design Supervisors, who confirm or reject the slot and then assign the artist -- through the
// existing assign-design / assign-artist endpoints, so the artist is held on the order and read from
// there. Table and states: db/create-design-schedule.js.
const router = express.Router();
const ROUTE = '/design-schedule';

const NOTIFY_TYPE = 'design_schedule';
const ARTIST_SUB_STATUSES = ['For Artist', 'For Artist (Revision)'];
// The states each order type can be scheduled from: before or just in the design queue, no artist yet.
const JO_SCHEDULABLE_SUBS = ['Pending', 'For Design Supervisor'];
const NSTDJO_SCHEDULABLE_SUBS = ['Pending', 'SBU Approved', 'For Design Supervisor'];
const SITE_INSPECTION = 'SITE INSPECTION';

const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

// Wall-clock Philippine time, stored as written -- the same convention as planned_start_at, which
// the artist's assignment copies this into. "2026-10-31T09:00" -> "2026-10-31 09:00:00".
function parseDateTime(v) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(String(v || '').trim());
  return m ? `${m[1]} ${m[2]}:00` : null;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
function displaySlot(start, end) {
  const [d, t] = String(start).split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const time = (s) => { const [h, mi] = String(s).split(':').map(Number); return `${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };
  return `${String(da).padStart(2, '0')} ${MONTHS[mo - 1]} ${y}, ${time(t)}${end ? `-${time(String(end).split(' ')[1])}` : ''}`;
}

async function logAudit(conn, { id, userId, eventType = 'Updated', fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('DesignSchedule', ?, ?, ?, ?, ?, ?)`,
    [id, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId],
  );
}

async function logOrderAudit(conn, orderType, orderId, userId, fieldName, oldValue, newValue) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [orderType === 'JO' ? 'JobOrder' : 'NonStandardJobOrder', orderId, fieldName === 'sub_status' ? 'Status Change' : 'Updated',
      fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId],
  );
}

async function notifyUsers(conn, userIds, { title, message = null, scheduleId }) {
  for (const userId of [...new Set(userIds.filter(Boolean).map(Number))]) {
    await conn.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
       VALUES (?, ?, ?, ?, 'DesignSchedule', ?)`,
      [userId, NOTIFY_TYPE, title, message, scheduleId],
    );
  }
}

// Which side of the hand-off this user is on. The SBU flag and the Design Supervisor flag are the same
// ones the rest of the design workflow gates on. An account holding both (the admin) acts for both, so
// its reschedules apply straight away -- there is nobody else on its own side to wait for. An Artist
// who is not a supervisor sees only the slots assigned to them.
async function sideOf(userId) {
  const [[u]] = await pool.query(
    'SELECT account_type, employee_id, is_design_supervisor, is_sales_business_unit FROM users WHERE id = ?', [userId],
  );
  const admin = u?.account_type === 'System Admin';
  const sbu = !!u?.is_sales_business_unit || admin;
  const design = !!u?.is_design_supervisor || admin;
  return {
    sbu, design, both: sbu && design,
    artistEmployeeId: !sbu && !design && u?.account_type === 'Artist' ? u.employee_id : null,
  };
}

const BASE_SELECT = `
  SELECT ds.*,
         COALESCE(jo.job_order_no, n.nstdjo_no) AS order_no,
         COALESCE(jo.description, n.description) AS description,
         COALESCE(jo.status, n.status) AS order_status,
         COALESCE(jo.sub_status, n.sub_status) AS order_sub_status,
         COALESCE(jo.artist_id, n.artist_employee_id) AS artist_id,
         COALESCE(jo.layout_job_type_id, n.layout_job_type_id) AS layout_job_type_id,
         COALESCE(jo.layout_qty, n.layout_qty) AS layout_qty,
         COALESCE(jo.planned_start_at, n.planned_start_at) AS planned_start_at,
         COALESCE(jo.planned_end_at, n.planned_end_at) AS planned_end_at,
         COALESCE(jo.layout_started_at, n.layout_started_at) AS layout_started_at,
         COALESCE(jo.layout_ended_at, n.layout_ended_at) AS layout_ended_at,
         n.job_type_id AS nstdjo_job_type_id,
         c.name AS customer_name,
         TRIM(CONCAT(COALESCE(ae.first_name, ''), ' ', COALESCE(ae.last_name, ''))) AS artist_name,
         cu.display_name AS created_by_name,
         cf.display_name AS confirmed_by_name,
         pu.display_name AS proposed_by_name
    FROM design_schedules ds
    LEFT JOIN job_orders jo ON ds.order_type = 'JO' AND jo.id = ds.order_id
    LEFT JOIN non_standard_job_orders n ON ds.order_type = 'NSTDJO' AND n.id = ds.order_id
    LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
    LEFT JOIN non_standard_sales_orders nss ON nss.id = jo.nsso_id
    LEFT JOIN customers c ON c.id = COALESCE(n.customer_id, so.customer_id, nss.customer_id)
    LEFT JOIN employees ae ON ae.id = COALESCE(jo.artist_id, n.artist_employee_id)
    LEFT JOIN users cu ON cu.id = ds.created_by_user_id
    LEFT JOIN users cf ON cf.id = ds.confirmed_by_user_id
    LEFT JOIN users pu ON pu.id = ds.proposed_by_user_id`;

// Where a confirmed slot stands, read off the order rather than stored: the artist and the finished
// layout both live there, and a copy here could only drift from them.
function phaseOf(r) {
  if (r.status === 'Cancelled' || r.order_status === 'Cancelled') return 'Cancelled';
  if (r.status !== 'Confirmed') return r.status;
  if (r.layout_ended_at) return 'Done';
  if (r.artist_id && ARTIST_SUB_STATUSES.includes(r.order_sub_status)) return 'Assigned';
  return 'Confirmed';
}

// CARRY-OVER. A confirmed slot whose layout is not finished by the end of its day shows at the top of
// today on the calendar, marked with the day it was meant for, and keeps rolling forward one day at a
// time until the artist finishes it. Worked out on read, so no overnight job has to have run, and the
// slot keeps its original date for the record.
function decorate(r, today = manilaToday()) {
  const phase = phaseOf(r);
  const day = String(r.scheduled_start).slice(0, 10);
  const carried = (phase === 'Confirmed' || phase === 'Assigned') && day < today;
  return {
    ...r,
    phase,
    display_date: carried ? today : day,
    carried_over_from: carried ? day : null,
  };
}

async function loadSchedule(conn, id, lock = false) {
  const [[row]] = await conn.query(`${BASE_SELECT} WHERE ds.id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  return row ? decorate(row) : null;
}

// May this order be put on the calendar? Returns the order row, or an error message.
async function checkSchedulable(conn, orderType, orderId) {
  if (orderType === 'JO') {
    const [[jo]] = await conn.query(
      'SELECT id, job_order_no AS order_no, description, status, sub_status, layout_ended_at, is_on_hold FROM job_orders WHERE id = ? FOR UPDATE',
      [orderId],
    );
    if (!jo) return { error: 'Job Order not found.' };
    if (jo.status !== DESIGN_QUEUE_STATUS || !JO_SCHEDULABLE_SUBS.includes(jo.sub_status) || jo.layout_ended_at) {
      return { error: `${jo.order_no} is ${jo.sub_status} -- only a Job Order waiting for Design can be scheduled.` };
    }
    if (jo.is_on_hold) return { error: `${jo.order_no} is on hold.` };
    return { order: jo };
  }
  if (orderType === 'NSTDJO') {
    const [[n]] = await conn.query(
      `SELECT id, nstdjo_no AS order_no, description, status, sub_status, job_type, forwarded_at, layout_ended_at
         FROM non_standard_job_orders WHERE id = ? FOR UPDATE`, [orderId],
    );
    if (!n) return { error: 'Non-Standard Job Order not found.' };
    if (n.job_type === SITE_INSPECTION) return { error: 'A Site Inspection has no layout, so it is not scheduled with Design.' };
    if (n.status !== DESIGN_QUEUE_STATUS || !NSTDJO_SCHEDULABLE_SUBS.includes(n.sub_status) || n.layout_ended_at) {
      return { error: `${n.order_no} is ${n.sub_status} -- only an approved NSTDJO waiting for Design can be scheduled.` };
    }
    return { order: n };
  }
  return { error: 'Choose JO or NSTDJO.' };
}

async function hasActiveSchedule(conn, orderType, orderId, exceptId = 0) {
  const [[r]] = await conn.query(
    "SELECT id FROM design_schedules WHERE order_type = ? AND order_id = ? AND status <> 'Cancelled' AND id <> ? LIMIT 1",
    [orderType, orderId, exceptId],
  );
  return !!r;
}

// Forwarding the slot forwards the order with it: there is no point asking Design to confirm a time for
// an order that is not in their queue. Same transition, same audit row, as the order's own Forward; the
// "needs an artist" notice is replaced by the schedule's own, which says when.
async function forwardOrderToDesign(conn, schedule, userId) {
  if (schedule.order_type === 'JO' && schedule.order_sub_status === 'Pending') {
    await conn.query("UPDATE job_orders SET sub_status = 'For Design Supervisor', updated_at = NOW() WHERE id = ?", [schedule.order_id]);
    await logOrderAudit(conn, 'JO', schedule.order_id, userId, 'sub_status', 'Pending', 'For Design Supervisor');
  }
  if (schedule.order_type === 'NSTDJO' && ['Pending', 'SBU Approved'].includes(schedule.order_sub_status)) {
    await conn.query(
      "UPDATE non_standard_job_orders SET sub_status = 'For Design Supervisor', forwarded_at = COALESCE(forwarded_at, NOW()), updated_at = NOW() WHERE id = ?",
      [schedule.order_id],
    );
    await logOrderAudit(conn, 'NSTDJO', schedule.order_id, userId, 'sub_status', schedule.order_sub_status, 'For Design Supervisor');
  }
}

async function forwardSchedule(conn, schedule, userId) {
  await conn.query(
    `UPDATE design_schedules SET status = 'For Confirmation', reject_reason = NULL,
            forwarded_by_user_id = ?, forwarded_at = NOW() WHERE id = ?`, [userId, schedule.id],
  );
  await logAudit(conn, { id: schedule.id, userId, eventType: 'Status Change', fieldName: 'status', oldValue: schedule.status, newValue: 'For Confirmation' });
  await forwardOrderToDesign(conn, schedule, userId);
  await notifyDesignSupervisors(conn, {
    title: `${schedule.order_no} scheduled for ${displaySlot(schedule.scheduled_start, schedule.scheduled_end)} -- please confirm`,
    message: schedule.description ? String(schedule.description).slice(0, 500) : null,
    relatedType: 'DesignSchedule',
    relatedId: schedule.id,
    excludeUserId: userId,
    type: NOTIFY_TYPE,
  });
}

// The SBU side of a slot: whoever made it and whoever forwarded it.
const sbuRecipients = (s) => [s.created_by_user_id, s.forwarded_by_user_id];

// A wrapper for the write routes: one transaction, the slot loaded and locked, the result re-read.
function withSchedule(handler) {
  return async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const schedule = await loadSchedule(conn, req.params.id, true);
      if (!schedule) { await conn.rollback(); return res.status(404).json({ error: 'Schedule not found.' }); }
      const side = await sideOf(req.user.id);
      const fail = await handler({ conn, schedule, side, req });
      if (fail) { await conn.rollback(); return res.status(fail[0]).json({ error: fail[1] }); }
      await conn.commit();
      res.json(await loadSchedule(pool, req.params.id));
    } catch (err) {
      await conn.rollback();
      next(err);
    } finally { conn.release(); }
  };
}

function readSlot(body) {
  const start = parseDateTime(body?.scheduled_start);
  const end = parseDateTime(body?.scheduled_end);
  if (!start || !end) return { error: 'Date, start time and end time are required.' };
  if (end <= start) return { error: 'The end time must be after the start time.' };
  return { start, end };
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [side, [artists], [pmsJobTypes]] = await Promise.all([
      sideOf(req.user.id),
      pool.query(
        `SELECT e.id, e.first_name, e.last_name, e.position_title FROM employees e
           JOIN users u ON u.employee_id = e.id
          WHERE u.account_type = 'Artist' AND u.is_active = TRUE AND e.is_active = TRUE
          ORDER BY e.first_name, e.last_name`,
      ),
      pool.query('SELECT id, code, display_name, minutes_consume, job_type_id FROM pms_job_types ORDER BY display_name'),
    ]);
    res.json({ side, artists, pmsJobTypes, today: manilaToday() });
  } catch (err) { next(err); }
});

// The calendar window. A carried-over slot is included whenever the window contains today.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const { from, to } = req.query;
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD).' });
    const today = manilaToday();
    const side = await sideOf(req.user.id);

    const conditions = [`(DATE(ds.scheduled_start) BETWEEN ? AND ?
      OR DATE(ds.proposed_start) BETWEEN ? AND ?
      OR (? BETWEEN ? AND ? AND ds.status = 'Confirmed' AND DATE(ds.scheduled_start) < ?
          AND COALESCE(jo.layout_ended_at, n.layout_ended_at) IS NULL))`];
    const params = [from, to, from, to, today, from, to, today];
    if (req.query.include_cancelled !== '1') conditions.push("ds.status <> 'Cancelled'");
    const artistId = side.artistEmployeeId || req.query.artist_id;
    if (artistId) {
      conditions.push("COALESCE(jo.artist_id, n.artist_employee_id) = ? AND ds.status = 'Confirmed'");
      params.push(artistId);
    }
    const [rows] = await pool.query(`${BASE_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY ds.scheduled_start`, params);
    res.json(rows.map((r) => decorate(r, today)));
  } catch (err) { next(err); }
});

// Orders the SBU can put on the calendar: waiting for Design, no artist yet, not already scheduled.
// An SBU's NSTDJO list is their own groups' (both SBUs and Marketing), the same reach the NSTDJO list
// gives them.
router.get('/eligible', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const notScheduled = (type, col) => `NOT EXISTS (SELECT 1 FROM design_schedules ds
      WHERE ds.order_type = '${type}' AND ds.order_id = ${col} AND ds.status <> 'Cancelled')`;
    if (req.query.type === 'NSTDJO') {
      const params = [DESIGN_QUEUE_STATUS, NSTDJO_SCHEDULABLE_SUBS, SITE_INSPECTION];
      let scopeSql = '';
      const scope = await getSbuScope(req.user.id, { withMarketing: true });
      if (scope) { scopeSql = 'AND n.sales_division_id IN (?)'; params.push(scope.departmentIds.length ? scope.departmentIds : [0]); }
      const [rows] = await pool.query(
        `SELECT n.id, n.nstdjo_no AS order_no, n.description, n.sub_status, n.delivery_date, c.name AS customer_name
           FROM non_standard_job_orders n LEFT JOIN customers c ON c.id = n.customer_id
          WHERE n.status = ? AND n.sub_status IN (?) AND n.job_type <> ? AND n.layout_ended_at IS NULL
            AND ${notScheduled('NSTDJO', 'n.id')} ${scopeSql}
          ORDER BY n.id DESC LIMIT 500`, params,
      );
      return res.json(rows);
    }
    const [rows] = await pool.query(
      `SELECT jo.id, jo.job_order_no AS order_no, jo.description, jo.sub_status, jo.delivery_date, c.name AS customer_name
         FROM job_orders jo
         LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
         LEFT JOIN non_standard_sales_orders nss ON nss.id = jo.nsso_id
         LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, nss.customer_id)
        WHERE jo.status = ? AND jo.sub_status IN (?) AND jo.layout_ended_at IS NULL AND jo.is_on_hold = FALSE
          AND ${notScheduled('JO', 'jo.id')}
        ORDER BY jo.id DESC LIMIT 500`,
      [DESIGN_QUEUE_STATUS, JO_SCHEDULABLE_SUBS],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const schedule = await loadSchedule(pool, req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found.' });
    const side = await sideOf(req.user.id);
    if (side.artistEmployeeId && String(schedule.artist_id) !== String(side.artistEmployeeId)) {
      return res.status(403).json({ error: 'This schedule is not assigned to you.' });
    }
    const [history] = await pool.query(
      `SELECT a.event_type, a.field_name, a.old_value, a.new_value, a.set_at, u.display_name AS set_by_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
        WHERE a.auditable_type = 'DesignSchedule' AND a.auditable_id = ? ORDER BY a.id DESC`, [req.params.id],
    );
    res.json({ ...schedule, history });
  } catch (err) { next(err); }
});

// SBU: put an order on the calendar, optionally forwarding it to Design in the same step.
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const { order_type: orderType, order_id: orderId, notes } = req.body || {};
  const slot = readSlot(req.body);
  if (slot.error) return res.status(400).json({ error: slot.error });

  const conn = await pool.getConnection();
  try {
    if (!(await sideOf(req.user.id)).sbu) return res.status(403).json({ error: 'Only an SBU can schedule a job order.' });
    await conn.beginTransaction();
    const { error } = await checkSchedulable(conn, orderType, orderId);
    if (error) { await conn.rollback(); return res.status(409).json({ error }); }
    if (await hasActiveSchedule(conn, orderType, orderId)) {
      await conn.rollback();
      return res.status(409).json({ error: 'This order is already on the Design Schedule -- move that slot instead.' });
    }
    const [r] = await conn.query(
      `INSERT INTO design_schedules (order_type, order_id, scheduled_start, scheduled_end, notes, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderType, orderId, slot.start, slot.end, notes || null, req.user.id],
    );
    await logAudit(conn, { id: r.insertId, userId: req.user.id, eventType: 'Created', fieldName: 'scheduled_start', newValue: `${slot.start} - ${slot.end}` });
    if (req.body.forward) await forwardSchedule(conn, await loadSchedule(conn, r.insertId), req.user.id);
    await conn.commit();
    res.status(201).json(await loadSchedule(pool, r.insertId));
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// SBU: change a slot Design has not confirmed yet. A confirmed one is moved through /reschedule.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  if (!side.sbu) return [403, 'Only an SBU can edit the schedule.'];
  if (!['Draft', 'Rejected', 'For Confirmation'].includes(schedule.status)) {
    return [409, `This slot is ${schedule.status} -- use Reschedule to move it.`];
  }
  const slot = readSlot(req.body);
  if (slot.error) return [400, slot.error];
  await conn.query(
    'UPDATE design_schedules SET scheduled_start = ?, scheduled_end = ?, notes = ? WHERE id = ?',
    [slot.start, slot.end, req.body.notes ?? schedule.notes, schedule.id],
  );
  if (slot.start !== schedule.scheduled_start || slot.end !== schedule.scheduled_end) {
    await logAudit(conn, {
      id: schedule.id, userId: req.user.id, fieldName: 'scheduled_start',
      oldValue: `${schedule.scheduled_start} - ${schedule.scheduled_end}`, newValue: `${slot.start} - ${slot.end}`,
    });
  }
  return null;
}));

router.post('/:id/forward', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  if (!side.sbu) return [403, 'Only an SBU can forward the schedule.'];
  if (!['Draft', 'Rejected'].includes(schedule.status)) return [409, `This slot is already ${schedule.status}.`];
  if (schedule.order_status === 'Cancelled') return [409, `${schedule.order_no} is cancelled.`];
  await forwardSchedule(conn, schedule, req.user.id);
  return null;
}));

router.post('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  if (!side.sbu) return [403, 'Only an SBU can cancel a schedule.'];
  if (schedule.status === 'Cancelled') return [409, 'This slot is already cancelled.'];
  if (['Assigned', 'Done'].includes(schedule.phase)) return [409, 'An artist is already on this order -- reschedule it instead.'];
  await conn.query("UPDATE design_schedules SET status = 'Cancelled', proposed_start = NULL, proposed_end = NULL, proposed_by_side = NULL WHERE id = ?", [schedule.id]);
  await logAudit(conn, { id: schedule.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', oldValue: schedule.status, newValue: 'Cancelled' });
  if (schedule.status !== 'Draft') {
    await notifyDesignSupervisors(conn, {
      title: `${schedule.order_no}'s design schedule was cancelled`, relatedType: 'DesignSchedule', relatedId: schedule.id,
      excludeUserId: req.user.id, type: NOTIFY_TYPE,
    });
  }
  return null;
}));

// Design Supervisor: accept or turn down a forwarded slot.
router.post('/:id/confirm', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  if (!side.design) return [403, 'Only a Design Supervisor can confirm the schedule.'];
  if (schedule.status !== 'For Confirmation') return [409, `This slot is ${schedule.status}, not waiting for confirmation.`];
  await conn.query(
    "UPDATE design_schedules SET status = 'Confirmed', confirmed_by_user_id = ?, confirmed_at = NOW() WHERE id = ?",
    [req.user.id, schedule.id],
  );
  await logAudit(conn, { id: schedule.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', oldValue: schedule.status, newValue: 'Confirmed' });
  await notifyUsers(conn, sbuRecipients(schedule).filter((u) => String(u) !== String(req.user.id)), {
    title: `Design confirmed ${schedule.order_no} for ${displaySlot(schedule.scheduled_start, schedule.scheduled_end)}`,
    scheduleId: schedule.id,
  });
  return null;
}));

router.post('/:id/reject', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  if (!side.design) return [403, 'Only a Design Supervisor can reject the schedule.'];
  if (schedule.status !== 'For Confirmation') return [409, `This slot is ${schedule.status}, not waiting for confirmation.`];
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return [400, 'Say why, so the SBU knows what to change.'];
  await conn.query("UPDATE design_schedules SET status = 'Rejected', reject_reason = ? WHERE id = ?", [reason, schedule.id]);
  await logAudit(conn, { id: schedule.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', oldValue: schedule.status, newValue: `Rejected: ${reason}` });
  await notifyUsers(conn, sbuRecipients(schedule).filter((u) => String(u) !== String(req.user.id)), {
    title: `Design rejected the schedule for ${schedule.order_no}`, message: reason, scheduleId: schedule.id,
  });
  return null;
}));

// Puts new dates into force. When an artist is already on the order, their planned window moves with
// it -- same length, new start -- since the assignment took its Planned Start from this slot.
async function applySlot(conn, schedule, start, end, userId) {
  await conn.query(
    `UPDATE design_schedules SET scheduled_start = ?, scheduled_end = ?, proposed_start = NULL, proposed_end = NULL,
            proposed_by_side = NULL, proposed_by_user_id = NULL, proposed_at = NULL, proposal_note = NULL WHERE id = ?`,
    [start, end, schedule.id],
  );
  await logAudit(conn, {
    id: schedule.id, userId, fieldName: 'scheduled_start',
    oldValue: `${schedule.scheduled_start} - ${schedule.scheduled_end}`, newValue: `${start} - ${end}`,
  });
  if (schedule.phase !== 'Assigned' || !schedule.planned_start_at) return;
  const length = schedule.planned_end_at
    ? new Date(String(schedule.planned_end_at).replace(' ', 'T')).getTime() - new Date(String(schedule.planned_start_at).replace(' ', 'T')).getTime()
    : null;
  const plannedEnd = length === null ? null : (() => {
    const d = new Date(new Date(start.replace(' ', 'T')).getTime() + length);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  })();
  const table = schedule.order_type === 'JO' ? 'job_orders' : 'non_standard_job_orders';
  await conn.query(`UPDATE ${table} SET planned_start_at = ?, planned_end_at = ?, updated_at = NOW() WHERE id = ?`, [start, plannedEnd, schedule.order_id]);
  await logOrderAudit(conn, schedule.order_type, schedule.order_id, userId, 'planned_start_at', schedule.planned_start_at, start);
  await notifyAssignedArtist(conn, {
    artistEmployeeId: schedule.artist_id,
    title: `${schedule.order_no} was rescheduled to ${displaySlot(start, end)}`,
    relatedType: 'DesignSchedule', relatedId: schedule.id, type: NOTIFY_TYPE,
  });
}

// Either side moves a confirmed slot. It stays a proposal until the other side accepts: Design's move
// waits on the SBU, the SBU's on Design.
router.post('/:id/reschedule', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  if (!side.sbu && !side.design) return [403, 'Only the SBU or a Design Supervisor can reschedule.'];
  if (schedule.status !== 'Confirmed') return [409, `Only a confirmed slot is rescheduled -- this one is ${schedule.status}.`];
  if (schedule.phase === 'Done') return [409, 'The layout is already finished.'];
  const slot = readSlot(req.body);
  if (slot.error) return [400, slot.error];
  const note = String(req.body?.note || '').trim() || null;

  if (side.both) { await applySlot(conn, schedule, slot.start, slot.end, req.user.id); return null; }

  const mySide = side.design ? 'DESIGN' : 'SBU';
  if (schedule.proposed_by_side && schedule.proposed_by_side !== mySide) {
    return [409, 'The other side has already proposed a new time -- accept or reject it first.'];
  }
  await conn.query(
    `UPDATE design_schedules SET proposed_start = ?, proposed_end = ?, proposed_by_side = ?, proposed_by_user_id = ?,
            proposed_at = NOW(), proposal_note = ? WHERE id = ?`,
    [slot.start, slot.end, mySide, req.user.id, note, schedule.id],
  );
  await logAudit(conn, { id: schedule.id, userId: req.user.id, fieldName: 'proposed_start', newValue: `${slot.start} - ${slot.end} (${mySide})` });
  const title = `${schedule.order_no}: ${mySide === 'DESIGN' ? 'Design' : 'the SBU'} wants to move it to ${displaySlot(slot.start, slot.end)} -- please confirm`;
  if (mySide === 'DESIGN') {
    await notifyUsers(conn, sbuRecipients(schedule), { title, message: note, scheduleId: schedule.id });
  } else {
    await notifyDesignSupervisors(conn, { title, message: note, relatedType: 'DesignSchedule', relatedId: schedule.id, excludeUserId: req.user.id, type: NOTIFY_TYPE });
  }
  return null;
}));

// The other side answers a proposal; the proposer may withdraw their own.
function proposalGate(schedule, side, { proposer }) {
  if (!schedule.proposed_by_side) return [409, 'There is no pending reschedule on this slot.'];
  if (side.both) return null;
  const mine = (schedule.proposed_by_side === 'DESIGN' && side.design) || (schedule.proposed_by_side === 'SBU' && side.sbu);
  if (proposer && !mine) return [403, 'Only the side that proposed the new time can withdraw it.'];
  if (!proposer && mine) return [403, `This reschedule is waiting on ${schedule.proposed_by_side === 'DESIGN' ? 'the SBU' : 'Design'}, not you.`];
  return null;
}

router.post('/:id/proposal/accept', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  const fail = proposalGate(schedule, side, { proposer: false });
  if (fail) return fail;
  await applySlot(conn, schedule, schedule.proposed_start, schedule.proposed_end, req.user.id);
  await notifyUsers(conn, [schedule.proposed_by_user_id], {
    title: `New time for ${schedule.order_no} accepted: ${displaySlot(schedule.proposed_start, schedule.proposed_end)}`, scheduleId: schedule.id,
  });
  return null;
}));

router.post('/:id/proposal/reject', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  const fail = proposalGate(schedule, side, { proposer: false });
  if (fail) return fail;
  const reason = String(req.body?.reason || '').trim() || null;
  await conn.query(
    `UPDATE design_schedules SET proposed_start = NULL, proposed_end = NULL, proposed_by_side = NULL,
            proposed_by_user_id = NULL, proposed_at = NULL, proposal_note = NULL WHERE id = ?`, [schedule.id],
  );
  await logAudit(conn, { id: schedule.id, userId: req.user.id, fieldName: 'proposed_start', oldValue: `${schedule.proposed_start} - ${schedule.proposed_end}`, newValue: `Rejected${reason ? `: ${reason}` : ''}` });
  await notifyUsers(conn, [schedule.proposed_by_user_id], {
    title: `New time for ${schedule.order_no} was not accepted -- it stays ${displaySlot(schedule.scheduled_start, schedule.scheduled_end)}`,
    message: reason, scheduleId: schedule.id,
  });
  return null;
}));

router.post('/:id/proposal/withdraw', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  const fail = proposalGate(schedule, side, { proposer: true });
  if (fail) return fail;
  await conn.query(
    `UPDATE design_schedules SET proposed_start = NULL, proposed_end = NULL, proposed_by_side = NULL,
            proposed_by_user_id = NULL, proposed_at = NULL, proposal_note = NULL WHERE id = ?`, [schedule.id],
  );
  await logAudit(conn, { id: schedule.id, userId: req.user.id, fieldName: 'proposed_start', oldValue: `${schedule.proposed_start} - ${schedule.proposed_end}`, newValue: 'Withdrawn' });
  return null;
}));

module.exports = router;
