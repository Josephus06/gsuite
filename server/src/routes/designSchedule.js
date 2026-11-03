const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');
const { notifyDesignSupervisors, notifyAssignedArtist } = require('../lib/designNotifications');
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');
const { DESIGN_QUEUE_STATUS, DESIGN_QUEUE_SUB_STATUSES } = require('../lib/designSupervisorVisibility');

// Design > Design Schedule. Table and states: db/create-design-schedule.js.
//
// THE CALENDAR FLOW (asked 2026-11-03, replacing the slot-by-slot confirmation of 2026-10-31):
//   1. An Account Officer schedules their own JO / NSTDJO -- date, time, preferred artist (Draft).
//   2. Their Sales Supervisor's calendar is the team's slots plus their own, and they can add theirs.
//   3. The SBU's calendar is everyone's. The SBU can change any slot's date or artist, and forwards
//      every unsent slot to Design at once -- one calendar, a batch -- never slot by slot.
//   4. A Design Supervisor sets each slot's Layout Job Type + Qty and may revise its time or artist.
//      Approving with no revision approves the calendar; with revisions it goes back to the SBU.
//   5. The SBU approves the revisions (or returns the calendar to Design with a note).
//   6. Approved: every order is assigned to its artist -- the same write the order screens' Assign
//      Artist makes -- so it is on the artist's calendar and in Assigned JO.
// Whose slot it is, is the order's sales rep, scoped exactly as Estimates / Sales Orders are
// (lib/salesVisibility.js): an Account Officer their own, a Supervisor their people's too, an SBU the
// whole tree. An approved slot is moved afterwards by proposal, which the other side accepts.
const router = express.Router();
const ROUTE = '/design-schedule';

const NOTIFY_TYPE = 'design_schedule';
const ARTIST_SUB_STATUSES = ['For Artist', 'For Artist (Revision)'];
// The states each order type can be scheduled from: before or just in the design queue, no artist yet.
const JO_SCHEDULABLE_SUBS = ['Pending', 'For Design Supervisor'];
const NSTDJO_SCHEDULABLE_SUBS = ['Pending', 'SBU Approved', 'For Design Supervisor'];
const SITE_INSPECTION = 'SITE INSPECTION';
const BATCH_WITH_DESIGN = 'For Approval';
const BATCH_WITH_SBU = 'For SBU Approval';
const BATCH_APPROVED = 'Approved';

const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

// Wall-clock Philippine time, stored as written -- the same convention as planned_start_at, which
// the artist's assignment copies this into. "2026-10-31T09:00" -> "2026-10-31 09:00:00".
function parseDateTime(v) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(String(v || '').trim());
  return m ? `${m[1]} ${m[2]}:00` : null;
}
// Wall-clock arithmetic in UTC, so the server's own time zone never shifts the answer.
function addMinutes(wallClock, minutes) {
  const d = new Date(`${String(wallClock).replace(' ', 'T')}Z`);
  return new Date(d.getTime() + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
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

async function notifyUsers(conn, userIds, { title, message = null, relatedType = 'DesignSchedule', relatedId }) {
  for (const userId of [...new Set(userIds.filter(Boolean).map(Number))]) {
    await conn.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, NOTIFY_TYPE, title, message, relatedType, relatedId],
    );
  }
}

// Who this user is in the flow:
//   sales   -- Account Officer, Supervisor or SBU: schedules the orders in `scope` (employee ids of the
//              sales reps whose orders they cover; null = every order).
//   sbu     -- forwards the calendar, answers Design's revisions.
//   design  -- Design Supervisor: reviews and approves.
// System Admin is all three. An Artist who is none of them sees only their own approved slots.
async function sideOf(userId) {
  const [[u]] = await pool.query(
    `SELECT account_type, employee_id, is_design_supervisor, is_sales_business_unit, is_account_officer, is_supervisor
       FROM users WHERE id = ?`, [userId],
  );
  const admin = u?.account_type === 'System Admin';
  const sbu = !!u?.is_sales_business_unit || admin;
  const flagged = sbu || !!u?.is_account_officer || !!u?.is_supervisor;
  // Every Sales account schedules (asked 2026-11-03: "all sales"). One with none of the three flags is
  // treated as an Account Officer -- their own orders only -- since getSalesRepEmployeeScope would read
  // "no flag" as no restriction at all.
  const sales = flagged || u?.account_type === 'Sales';
  const design = !!u?.is_design_supervisor || admin;
  let scope = [];
  if (admin) scope = null;
  else if (flagged) scope = await getSalesRepEmployeeScope(userId, ROUTE);
  else if (sales) scope = (await userCan(userId, ROUTE, 'can_view_all')) ? null : [u.employee_id].filter(Boolean);
  return {
    userId: Number(userId), admin, sales, sbu, design, both: sbu && design, scope,
    artistEmployeeId: !sales && !design && u?.account_type === 'Artist' ? u.employee_id : null,
  };
}

// May this user plan this slot / order? Their own slot, or an order whose sales rep is in their scope.
function covers(side, repId, createdBy = null) {
  if (!side.sales) return false;
  if (side.scope === null) return true;
  if (createdBy && Number(createdBy) === side.userId) return true;
  return !!repId && side.scope.map(Number).includes(Number(repId));
}

// Delivery Date: optional, a plain YYYY-MM-DD.
function readDeliveryDate(body) {
  const v = String(body?.delivery_date || '').trim();
  if (!v) return { value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: 'Delivery Date must be a date.' };
  return { value: v };
}

// The sales rep behind the order: the JO's; an NSTDJO's, or whoever raised it when it names none.
const REP_SQL = 'COALESCE(jo.sales_rep_id, n.sales_rep_id, nu.employee_id)';
const person = (alias) => `NULLIF(TRIM(CONCAT(COALESCE(${alias}.first_name, ''), ' ', COALESCE(${alias}.last_name, ''))), '')`;

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
         ${REP_SQL} AS sales_rep_id,
         ${person('re')} AS sales_rep_name,
         c.name AS customer_name,
         ${person('ae')} AS assigned_artist_name,
         ${person('pe')} AS preferred_artist_name,
         ${person('qe')} AS proposed_artist_name,
         COALESCE(${person('ae')}, ${person('pe')}) AS artist_name,
         pj.display_name AS plan_layout_job_type_name,
         b.status AS batch_status,
         cu.display_name AS created_by_name,
         cf.display_name AS confirmed_by_name,
         pu.display_name AS proposed_by_name
    FROM design_schedules ds
    LEFT JOIN job_orders jo ON ds.order_type = 'JO' AND jo.id = ds.order_id
    LEFT JOIN non_standard_job_orders n ON ds.order_type = 'NSTDJO' AND n.id = ds.order_id
    LEFT JOIN users nu ON nu.id = n.created_by_user_id
    LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
    LEFT JOIN non_standard_sales_orders nss ON nss.id = jo.nsso_id
    LEFT JOIN customers c ON c.id = COALESCE(n.customer_id, so.customer_id, nss.customer_id)
    LEFT JOIN employees re ON re.id = ${REP_SQL}
    LEFT JOIN employees ae ON ae.id = COALESCE(jo.artist_id, n.artist_employee_id)
    LEFT JOIN employees pe ON pe.id = ds.preferred_artist_id
    LEFT JOIN employees qe ON qe.id = ds.proposed_artist_id
    LEFT JOIN pms_job_types pj ON pj.id = ds.plan_layout_job_type_id
    LEFT JOIN design_schedule_batches b ON b.id = ds.batch_id
    LEFT JOIN users cu ON cu.id = ds.created_by_user_id
    LEFT JOIN users cf ON cf.id = ds.confirmed_by_user_id
    LEFT JOIN users pu ON pu.id = ds.proposed_by_user_id`;

// Where a slot stands. Before approval: Draft, with Design, or revised and back with the SBU. After:
// read off the order -- the artist and the finished layout live there, and a copy here could drift.
function phaseOf(r) {
  if (r.status === 'Cancelled' || r.order_status === 'Cancelled') return 'Cancelled';
  if (r.status === 'For Approval') return r.batch_status === BATCH_WITH_SBU ? 'Revised' : 'For Approval';
  if (r.status !== 'Confirmed') return r.status;
  if (r.layout_ended_at) return 'Done';
  if (r.artist_id && ARTIST_SUB_STATUSES.includes(r.order_sub_status)) return 'Assigned';
  return 'Confirmed';
}

// CARRY-OVER. An approved slot whose layout is not finished by the end of its day shows at the top of
// today on the calendar, marked with the day it was meant for, and keeps rolling forward one day at a
// time until the artist finishes it. Worked out on read, so no overnight job has to have run, and the
// slot keeps its original date for the record.
function decorate(r, today = manilaToday()) {
  const phase = phaseOf(r);
  const day = String(r.scheduled_start).slice(0, 10);
  const carried = (phase === 'Confirmed' || phase === 'Assigned') && day < today;
  return { ...r, phase, display_date: carried ? today : day, carried_over_from: carried ? day : null };
}

async function loadSchedule(conn, id, lock = false) {
  const [[row]] = await conn.query(`${BASE_SELECT} WHERE ds.id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  return row ? decorate(row) : null;
}

// Which slots a user sees, as SQL: the ones they plan (sales scope), everything forwarded (Design),
// their own approved work (Artist). Anyone else holding the page sees it all.
function visibilitySql(side) {
  if (side.admin || side.scope === null) return { sql: '1 = 1', params: [] };
  const parts = [];
  const params = [];
  if (side.sales) {
    parts.push(`(ds.created_by_user_id = ?${side.scope.length ? ` OR ${REP_SQL} IN (?)` : ''})`);
    params.push(side.userId);
    if (side.scope.length) params.push(side.scope);
  }
  if (side.design) parts.push("ds.status <> 'Draft'");
  if (side.artistEmployeeId) {
    parts.push("(ds.status = 'Confirmed' AND COALESCE(jo.artist_id, n.artist_employee_id) = ?)");
    params.push(side.artistEmployeeId);
  }
  if (!side.sales && !side.design && !side.artistEmployeeId) return { sql: '1 = 1', params: [] };
  return { sql: `(${parts.join(' OR ')})`, params };
}

// May this order be put on the calendar? Returns the order row, or an error message.
async function checkSchedulable(conn, orderType, orderId) {
  if (orderType === 'JO') {
    const [[jo]] = await conn.query(
      `SELECT id, job_order_no AS order_no, description, status, sub_status, layout_ended_at, is_on_hold, sales_rep_id
         FROM job_orders WHERE id = ? FOR UPDATE`, [orderId],
    );
    if (!jo) return { error: 'Job Order not found.' };
    if (jo.status !== DESIGN_QUEUE_STATUS || !JO_SCHEDULABLE_SUBS.includes(jo.sub_status) || jo.layout_ended_at) {
      return { error: `${jo.order_no} is ${jo.sub_status} -- only a Job Order waiting for Design can be scheduled.` };
    }
    if (jo.is_on_hold) return { error: `${jo.order_no} is on hold.` };
    return { order: jo, repId: jo.sales_rep_id };
  }
  if (orderType === 'NSTDJO') {
    const [[n]] = await conn.query(
      `SELECT n.id, n.nstdjo_no AS order_no, n.description, n.status, n.sub_status, n.job_type, n.layout_ended_at,
              COALESCE(n.sales_rep_id, u.employee_id) AS rep_id
         FROM non_standard_job_orders n LEFT JOIN users u ON u.id = n.created_by_user_id
        WHERE n.id = ? FOR UPDATE`, [orderId],
    );
    if (!n) return { error: 'Non-Standard Job Order not found.' };
    if (n.job_type === SITE_INSPECTION) return { error: 'A Site Inspection has no layout, so it is not scheduled with Design.' };
    if (n.status !== DESIGN_QUEUE_STATUS || !NSTDJO_SCHEDULABLE_SUBS.includes(n.sub_status) || n.layout_ended_at) {
      return { error: `${n.order_no} is ${n.sub_status} -- only an approved NSTDJO waiting for Design can be scheduled.` };
    }
    return { order: n, repId: n.rep_id };
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

// The preferred artist must be an Artist account -- the same rule assign-design enforces.
async function checkArtist(conn, artistId) {
  if (!artistId) return 'Choose the preferred artist.';
  const [[a]] = await conn.query(
    `SELECT e.id FROM employees e JOIN users u ON u.employee_id = e.id
      WHERE e.id = ? AND u.account_type = 'Artist' AND u.is_active = TRUE LIMIT 1`, [artistId],
  );
  return a ? null : 'That employee is not an active Artist.';
}

// Forwarding the calendar forwards each order with it: there is no point asking Design to plan an
// order that is not in their queue. Same transition, same audit row, as the order's own Forward.
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

// The approval's assignment: what PUT /job-orders/:id/assign-design and PUT /non-standard-job-orders/
// :id/assign-artist write, with Planned Start = the slot and Planned End = start + minutes x qty.
// Returns an error message, or null.
async function assignOrder(conn, s, userId) {
  const label = `${s.order_no}`;
  const artistError = await checkArtist(conn, s.preferred_artist_id);
  if (artistError) return `${label}: ${artistError}`;
  if (!s.plan_layout_job_type_id || !(Number(s.plan_layout_qty) > 0)) return `${label}: set its Layout - Job Type and Qty first.`;
  const [[jt]] = await conn.query('SELECT id, job_type_id, minutes_consume FROM pms_job_types WHERE id = ?', [s.plan_layout_job_type_id]);
  if (!jt) return `${label}: invalid Layout - Job Type.`;
  const qty = Number(s.plan_layout_qty);
  const plannedStart = s.scheduled_start;
  const plannedEnd = addMinutes(plannedStart, Number(jt.minutes_consume || 0) * qty);

  if (s.order_type === 'JO') {
    const [[jo]] = await conn.query('SELECT job_order_no, description, status, sub_status, artist_id FROM job_orders WHERE id = ? FOR UPDATE', [s.order_id]);
    if (!jo || ['Released', 'Cancelled'].includes(jo.status)) return `${label} is ${jo?.status || 'gone'} -- it can no longer be assigned.`;
    await conn.query(
      `UPDATE job_orders SET layout_job_type_id = ?, artist_id = ?, planned_start_at = ?, planned_end_at = ?, layout_qty = ?,
              sub_status = 'For Artist', layout_started_at = NULL, layout_ended_at = NULL, updated_at = NOW() WHERE id = ?`,
      [jt.id, s.preferred_artist_id, plannedStart, plannedEnd, qty, s.order_id],
    );
    // A (re)assignment restarts the layout clock, as assign-design does.
    await conn.query('DELETE FROM job_order_layout_sessions WHERE job_order_id = ?', [s.order_id]);
    await logOrderAudit(conn, 'JO', s.order_id, userId, 'layout_job_type_id', null, jt.id);
    await logOrderAudit(conn, 'JO', s.order_id, userId, 'artist_id', jo.artist_id, s.preferred_artist_id);
    await logOrderAudit(conn, 'JO', s.order_id, userId, 'planned_start_at', null, plannedStart);
    await logOrderAudit(conn, 'JO', s.order_id, userId, 'layout_qty', null, qty);
    await logOrderAudit(conn, 'JO', s.order_id, userId, 'sub_status', jo.sub_status, 'For Artist');
  } else {
    const [[n]] = await conn.query(
      'SELECT nstdjo_no, status, sub_status, artist_employee_id, job_type_id FROM non_standard_job_orders WHERE id = ? FOR UPDATE', [s.order_id]);
    if (!n || n.status === 'Cancelled') return `${label} is cancelled -- it can no longer be assigned.`;
    if (!DESIGN_QUEUE_SUB_STATUSES.includes(n.sub_status)) return `${label} is ${n.sub_status}, not in the design queue.`;
    if (String(jt.job_type_id) !== String(n.job_type_id)) return `${label}: that Layout - Job Type does not belong to this order's job type.`;
    await conn.query(
      `UPDATE non_standard_job_orders SET artist_employee_id = ?, layout_job_type_id = ?, layout_qty = ?,
              planned_start_at = ?, planned_end_at = ?, sub_status = 'For Artist', updated_at = NOW() WHERE id = ?`,
      [s.preferred_artist_id, jt.id, qty, plannedStart, plannedEnd, s.order_id],
    );
    await logOrderAudit(conn, 'NSTDJO', s.order_id, userId, 'artist_employee_id', n.artist_employee_id, s.preferred_artist_id);
    await logOrderAudit(conn, 'NSTDJO', s.order_id, userId, 'layout_job_type_id', null, jt.id);
    await logOrderAudit(conn, 'NSTDJO', s.order_id, userId, 'planned_start_at', null, plannedStart);
    if (n.sub_status !== 'For Artist') await logOrderAudit(conn, 'NSTDJO', s.order_id, userId, 'sub_status', n.sub_status, 'For Artist');
  }
  await notifyAssignedArtist(conn, {
    artistEmployeeId: s.preferred_artist_id,
    title: `${s.order_no} has been assigned to you -- ${displaySlot(s.scheduled_start, s.scheduled_end)}`,
    message: s.description ? String(s.description).slice(0, 500) : null,
    relatedType: 'DesignSchedule', relatedId: s.id, type: NOTIFY_TYPE,
  });
  return null;
}

async function loadBatch(conn, id, lock = false) {
  const [[batch]] = await conn.query(
    `SELECT b.*, fu.display_name AS forwarded_by_name, ru.display_name AS reviewed_by_name, au.display_name AS approved_by_name
       FROM design_schedule_batches b
       LEFT JOIN users fu ON fu.id = b.forwarded_by_user_id
       LEFT JOIN users ru ON ru.id = b.reviewed_by_user_id
       LEFT JOIN users au ON au.id = b.approved_by_user_id
      WHERE b.id = ?${lock ? ' FOR UPDATE' : ''}`, [id],
  );
  if (!batch) return null;
  const [items] = await conn.query(`${BASE_SELECT} WHERE ds.batch_id = ? AND ds.status <> 'Cancelled' ORDER BY ds.scheduled_start${lock ? ' FOR UPDATE' : ''}`, [id]);
  return { ...batch, items: items.map((r) => decorate(r)) };
}

// Approves the calendar: every slot in it assigned to its artist, all or nothing.
async function approveBatch(conn, batch, userId) {
  for (const s of batch.items.filter((x) => x.status === 'For Approval')) {
    const fail = await assignOrder(conn, s, userId);
    if (fail) return fail;
    await conn.query(
      "UPDATE design_schedules SET status = 'Confirmed', confirmed_by_user_id = ?, confirmed_at = NOW() WHERE id = ?", [userId, s.id]);
    await logAudit(conn, { id: s.id, userId, eventType: 'Status Change', fieldName: 'status', oldValue: 'For Approval', newValue: 'Approved' });
  }
  await conn.query(
    'UPDATE design_schedule_batches SET status = ?, approved_by_user_id = ?, approved_at = NOW() WHERE id = ?', [BATCH_APPROVED, userId, batch.id]);
  await notifyUsers(conn, [batch.forwarded_by_user_id, ...batch.items.map((s) => s.created_by_user_id)].filter((u) => Number(u) !== Number(userId)), {
    title: `Design calendar #${batch.id} approved -- ${batch.items.length} order(s) assigned to the artists`,
    relatedType: 'DesignScheduleBatch', relatedId: batch.id,
  });
  return null;
}

// A wrapper for the slot write routes: one transaction, the slot loaded and locked, the result re-read.
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

// The same for a calendar (batch).
function withBatch(handler) {
  return async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const batch = await loadBatch(conn, req.params.id, true);
      if (!batch) { await conn.rollback(); return res.status(404).json({ error: 'Calendar not found.' }); }
      const side = await sideOf(req.user.id);
      const fail = await handler({ conn, batch, side, req });
      if (fail) { await conn.rollback(); return res.status(fail[0]).json({ error: fail[1] }); }
      await conn.commit();
      res.json(await loadBatch(pool, req.params.id));
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
    // How many unsent slots the SBU would forward.
    let unsent = 0;
    if (side.sbu) {
      const vis = visibilitySql(side);
      const [[r]] = await pool.query(
        `SELECT COUNT(*) AS n FROM (${BASE_SELECT} WHERE ds.status = 'Draft' AND ${vis.sql}) x`, vis.params);
      unsent = Number(r.n);
    }
    const { scope, ...sideOut } = side;
    res.json({ side: sideOut, artists, pmsJobTypes, today: manilaToday(), unsent });
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
    const vis = visibilitySql(side);

    const conditions = [`(DATE(ds.scheduled_start) BETWEEN ? AND ?
      OR DATE(ds.proposed_start) BETWEEN ? AND ?
      OR (? BETWEEN ? AND ? AND ds.status = 'Confirmed' AND DATE(ds.scheduled_start) < ?
          AND COALESCE(jo.layout_ended_at, n.layout_ended_at) IS NULL))`, vis.sql];
    const params = [from, to, from, to, today, from, to, today, ...vis.params];
    if (req.query.include_cancelled !== '1') conditions.push("ds.status <> 'Cancelled'");
    // An artist's calendar: the work assigned to them, or planned for them while not yet approved.
    if (req.query.artist_id && !side.artistEmployeeId) {
      conditions.push('COALESCE(jo.artist_id, n.artist_employee_id, ds.preferred_artist_id) = ?');
      params.push(req.query.artist_id);
    }
    const [rows] = await pool.query(`${BASE_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY ds.scheduled_start`, params);
    res.json(rows.map((r) => decorate(r, today)));
  } catch (err) { next(err); }
});

// Calendars still in progress: with Design, or back with the SBU. Design sees all; the SBU the ones
// they forwarded (or that hold their slots).
router.get('/batches', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const side = await sideOf(req.user.id);
    if (!side.design && !side.sales) return res.json([]);
    const [rows] = await pool.query(
      `SELECT b.id FROM design_schedule_batches b WHERE b.status IN (?, ?)
        ${side.design || side.admin ? '' : 'AND b.forwarded_by_user_id = ?'} ORDER BY b.id`,
      side.design || side.admin ? [BATCH_WITH_DESIGN, BATCH_WITH_SBU] : [BATCH_WITH_DESIGN, BATCH_WITH_SBU, side.userId],
    );
    res.json(await Promise.all(rows.map((r) => loadBatch(pool, r.id))));
  } catch (err) { next(err); }
});

router.get('/batches/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const batch = await loadBatch(pool, req.params.id);
    if (!batch) return res.status(404).json({ error: 'Calendar not found.' });
    res.json(batch);
  } catch (err) { next(err); }
});

// Orders this user can put on the calendar: waiting for Design, no artist yet, not already scheduled,
// and theirs to plan -- the sales rep is in their scope.
router.get('/eligible', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const side = await sideOf(req.user.id);
    if (!side.sales) return res.json([]);
    const scopeSql = (col) => (side.scope === null ? '' : `AND ${col} IN (?)`);
    const scopeParams = side.scope === null ? [] : [side.scope.length ? side.scope : [0]];
    const notScheduled = (type, col) => `NOT EXISTS (SELECT 1 FROM design_schedules ds
      WHERE ds.order_type = '${type}' AND ds.order_id = ${col} AND ds.status <> 'Cancelled')`;
    if (req.query.type === 'NSTDJO') {
      const [rows] = await pool.query(
        `SELECT n.id, n.nstdjo_no AS order_no, n.description, n.sub_status, n.delivery_date, c.name AS customer_name
           FROM non_standard_job_orders n
           LEFT JOIN customers c ON c.id = n.customer_id
           LEFT JOIN users nu ON nu.id = n.created_by_user_id
          WHERE n.status = ? AND n.sub_status IN (?) AND n.job_type <> ? AND n.layout_ended_at IS NULL
            AND ${notScheduled('NSTDJO', 'n.id')} ${scopeSql('COALESCE(n.sales_rep_id, nu.employee_id)')}
          ORDER BY n.id DESC LIMIT 500`, [DESIGN_QUEUE_STATUS, NSTDJO_SCHEDULABLE_SUBS, SITE_INSPECTION, ...scopeParams],
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
          AND ${notScheduled('JO', 'jo.id')} ${scopeSql('jo.sales_rep_id')}
        ORDER BY jo.id DESC LIMIT 500`,
      [DESIGN_QUEUE_STATUS, JO_SCHEDULABLE_SUBS, ...scopeParams],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const side = await sideOf(req.user.id);
    const vis = visibilitySql(side);
    const [[row]] = await pool.query(`${BASE_SELECT} WHERE ds.id = ? AND ${vis.sql}`, [req.params.id, ...vis.params]);
    if (!row) return res.status(404).json({ error: 'Schedule not found, or not one of yours.' });
    const [history] = await pool.query(
      `SELECT a.event_type, a.field_name, a.old_value, a.new_value, a.set_at, u.display_name AS set_by_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
        WHERE a.auditable_type = 'DesignSchedule' AND a.auditable_id = ? ORDER BY a.id DESC`, [req.params.id],
    );
    res.json({ ...decorate(row), history });
  } catch (err) { next(err); }
});

// Sales: put one of their orders on the calendar, with the artist they would like.
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const { order_type: orderType, order_id: orderId, notes } = req.body || {};
  const slot = readSlot(req.body);
  if (slot.error) return res.status(400).json({ error: slot.error });
  const delivery = readDeliveryDate(req.body);
  if (delivery.error) return res.status(400).json({ error: delivery.error });

  const conn = await pool.getConnection();
  try {
    const side = await sideOf(req.user.id);
    if (!side.sales) return res.status(403).json({ error: 'Only Sales (Account Officer, Supervisor or SBU) schedules a job order.' });
    await conn.beginTransaction();
    const { error, repId } = await checkSchedulable(conn, orderType, orderId);
    if (error) { await conn.rollback(); return res.status(409).json({ error }); }
    if (!covers(side, repId)) { await conn.rollback(); return res.status(403).json({ error: 'That order is not yours or your team\'s.' }); }
    const artistError = await checkArtist(conn, req.body.preferred_artist_id);
    if (artistError) { await conn.rollback(); return res.status(400).json({ error: artistError }); }
    if (await hasActiveSchedule(conn, orderType, orderId)) {
      await conn.rollback();
      return res.status(409).json({ error: 'This order is already on the Design Schedule -- move that slot instead.' });
    }
    const [r] = await conn.query(
      `INSERT INTO design_schedules (order_type, order_id, scheduled_start, scheduled_end, preferred_artist_id, notes, delivery_date, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderType, orderId, slot.start, slot.end, req.body.preferred_artist_id, notes || null, delivery.value, req.user.id],
    );
    await logAudit(conn, { id: r.insertId, userId: req.user.id, eventType: 'Created', fieldName: 'scheduled_start', newValue: `${slot.start} - ${slot.end}` });
    await conn.commit();
    res.status(201).json(await loadSchedule(pool, r.insertId));
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// Sales: change an unsent slot -- date, time, artist, delivery date, notes. The SBU can change any slot
// on their calendar; an Account Officer or Supervisor the ones in their scope.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  if (!covers(side, schedule.sales_rep_id, schedule.created_by_user_id)) return [403, 'This slot is not yours or your team\'s.'];
  if (schedule.status !== 'Draft') {
    return [409, schedule.status === 'For Approval'
      ? 'This slot has been forwarded to Design -- it can be changed again if Design returns the calendar.'
      : `This slot is ${schedule.status} -- use Reschedule to move it.`];
  }
  const slot = readSlot(req.body);
  if (slot.error) return [400, slot.error];
  const delivery = req.body.delivery_date === undefined ? { value: schedule.delivery_date } : readDeliveryDate(req.body);
  if (delivery.error) return [400, delivery.error];
  const artistId = req.body.preferred_artist_id === undefined ? schedule.preferred_artist_id : req.body.preferred_artist_id;
  const artistError = await checkArtist(conn, artistId);
  if (artistError) return [400, artistError];
  await conn.query(
    'UPDATE design_schedules SET scheduled_start = ?, scheduled_end = ?, preferred_artist_id = ?, notes = ?, delivery_date = ? WHERE id = ?',
    [slot.start, slot.end, artistId, req.body.notes ?? schedule.notes, delivery.value, schedule.id],
  );
  if ((delivery.value || null) !== (schedule.delivery_date || null)) {
    await logAudit(conn, { id: schedule.id, userId: req.user.id, fieldName: 'delivery_date', oldValue: schedule.delivery_date, newValue: delivery.value });
  }
  if (String(artistId) !== String(schedule.preferred_artist_id)) {
    await logAudit(conn, { id: schedule.id, userId: req.user.id, fieldName: 'preferred_artist_id', oldValue: schedule.preferred_artist_id, newValue: artistId });
  }
  if (slot.start !== schedule.scheduled_start || slot.end !== schedule.scheduled_end) {
    await logAudit(conn, {
      id: schedule.id, userId: req.user.id, fieldName: 'scheduled_start',
      oldValue: `${schedule.scheduled_start} - ${schedule.scheduled_end}`, newValue: `${slot.start} - ${slot.end}`,
    });
  }
  return null;
}));

// Take a slot off the calendar. An unsent one: whoever may plan it. Once forwarded: the SBU only.
router.post('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  if (schedule.status === 'Cancelled') return [409, 'This slot is already cancelled.'];
  if (schedule.status === 'Draft' ? !covers(side, schedule.sales_rep_id, schedule.created_by_user_id) : !side.sbu) {
    return [403, schedule.status === 'Draft' ? 'This slot is not yours or your team\'s.' : 'Only the SBU can cancel a forwarded slot.'];
  }
  if (['Assigned', 'Done'].includes(schedule.phase)) return [409, 'An artist is already on this order -- reschedule it instead.'];
  await conn.query(
    "UPDATE design_schedules SET status = 'Cancelled', proposed_start = NULL, proposed_end = NULL, proposed_artist_id = NULL, proposed_by_side = NULL WHERE id = ?",
    [schedule.id]);
  await logAudit(conn, { id: schedule.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', oldValue: schedule.status, newValue: 'Cancelled' });
  if (schedule.status !== 'Draft') {
    await notifyDesignSupervisors(conn, {
      title: `${schedule.order_no}'s design schedule was cancelled`, relatedType: 'DesignSchedule', relatedId: schedule.id,
      excludeUserId: req.user.id, type: NOTIFY_TYPE,
    });
  }
  return null;
}));

// SBU: forward every unsent slot on their calendar to Design, as one calendar.
router.post('/forward', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const side = await sideOf(req.user.id);
    if (!side.sbu) return res.status(403).json({ error: 'Only the SBU forwards the calendar to Design.' });
    await conn.beginTransaction();
    const vis = visibilitySql(side);
    const [rows] = await conn.query(`${BASE_SELECT} WHERE ds.status = 'Draft' AND ${vis.sql} ORDER BY ds.scheduled_start FOR UPDATE`, vis.params);
    const drafts = rows.map((r) => decorate(r));
    const live = drafts.filter((s) => s.order_status !== 'Cancelled');
    if (!live.length) { await conn.rollback(); return res.status(409).json({ error: 'There is nothing new on the calendar to forward.' }); }
    const noArtist = live.find((s) => !s.preferred_artist_id);
    if (noArtist) { await conn.rollback(); return res.status(400).json({ error: `${noArtist.order_no} has no preferred artist yet.` }); }

    const [b] = await conn.query('INSERT INTO design_schedule_batches (status, forwarded_by_user_id) VALUES (?, ?)', [BATCH_WITH_DESIGN, req.user.id]);
    for (const s of drafts) {
      if (s.order_status === 'Cancelled') {
        await conn.query("UPDATE design_schedules SET status = 'Cancelled' WHERE id = ?", [s.id]);
        continue;
      }
      await conn.query(
        `UPDATE design_schedules SET status = 'For Approval', batch_id = ?, reject_reason = NULL,
                forwarded_by_user_id = ?, forwarded_at = NOW() WHERE id = ?`, [b.insertId, req.user.id, s.id]);
      await logAudit(conn, { id: s.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', oldValue: 'Draft', newValue: `For Approval (calendar #${b.insertId})` });
      await forwardOrderToDesign(conn, s, req.user.id);
    }
    await notifyDesignSupervisors(conn, {
      title: `Design calendar #${b.insertId} from the SBU -- ${live.length} order(s) to plan and approve`,
      relatedType: 'DesignScheduleBatch', relatedId: b.insertId, excludeUserId: req.user.id, type: NOTIFY_TYPE,
    });
    await conn.commit();
    res.status(201).json(await loadBatch(pool, b.insertId));
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// The gate for Design's work on a slot inside a calendar they are reviewing.
function designReviewGate(schedule, side) {
  if (!side.design) return [403, 'Only a Design Supervisor reviews the calendar.'];
  if (schedule.status !== 'For Approval' || schedule.batch_status !== BATCH_WITH_DESIGN) {
    return [409, 'This slot is not in a calendar waiting for Design.'];
  }
  return null;
}

// Design: the slot's Layout Job Type and Qty -- needed before the calendar can be approved.
router.put('/:id/layout', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  const fail = designReviewGate(schedule, side);
  if (fail) return fail;
  const jobTypeId = Number(req.body?.layout_job_type_id) || null;
  const qty = req.body?.layout_qty === undefined || req.body.layout_qty === '' ? null : Number(req.body.layout_qty);
  if (qty !== null && !(qty > 0)) return [400, 'Qty must be a positive number.'];
  if (jobTypeId) {
    const [[jt]] = await conn.query('SELECT id, job_type_id FROM pms_job_types WHERE id = ?', [jobTypeId]);
    if (!jt) return [400, 'Invalid Layout - Job Type.'];
    if (schedule.order_type === 'NSTDJO' && String(jt.job_type_id) !== String(schedule.nstdjo_job_type_id)) {
      return [400, 'That Layout - Job Type does not belong to this order\'s job type.'];
    }
  }
  await conn.query('UPDATE design_schedules SET plan_layout_job_type_id = ?, plan_layout_qty = ? WHERE id = ?', [jobTypeId, qty, schedule.id]);
  if (String(jobTypeId || '') !== String(schedule.plan_layout_job_type_id || '') || Number(qty || 0) !== Number(schedule.plan_layout_qty || 0)) {
    await logAudit(conn, { id: schedule.id, userId: req.user.id, fieldName: 'layout_job_type', newValue: `${jobTypeId || '--'} x ${qty || '--'}` });
  }
  return null;
}));

// Design: revise a slot's time and/or artist. It stays a revision until the SBU approves it.
router.post('/:id/revise', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  const fail = designReviewGate(schedule, side);
  if (fail) return fail;
  const slot = readSlot(req.body);
  if (slot.error) return [400, slot.error];
  const artistId = Number(req.body.preferred_artist_id) || schedule.preferred_artist_id;
  const artistError = await checkArtist(conn, artistId);
  if (artistError) return [400, artistError];
  const sameTime = slot.start === schedule.scheduled_start && slot.end === schedule.scheduled_end;
  const sameArtist = String(artistId) === String(schedule.preferred_artist_id);
  if (sameTime && sameArtist) return [400, 'Nothing changed -- pick a new time or another artist.'];
  const note = String(req.body?.note || '').trim() || null;
  await conn.query(
    `UPDATE design_schedules SET proposed_start = ?, proposed_end = ?, proposed_artist_id = ?, proposed_by_side = 'DESIGN',
            proposed_by_user_id = ?, proposed_at = NOW(), proposal_note = ? WHERE id = ?`,
    [slot.start, slot.end, sameArtist ? null : artistId, req.user.id, note, schedule.id],
  );
  await logAudit(conn, { id: schedule.id, userId: req.user.id, fieldName: 'revision', newValue: `${slot.start} - ${slot.end}${sameArtist ? '' : `, artist ${artistId}`}` });
  return null;
}));

router.post('/:id/revise/withdraw', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  const fail = designReviewGate(schedule, side);
  if (fail) return fail;
  if (!schedule.proposed_by_side) return [409, 'There is no revision on this slot.'];
  await conn.query(
    `UPDATE design_schedules SET proposed_start = NULL, proposed_end = NULL, proposed_artist_id = NULL, proposed_by_side = NULL,
            proposed_by_user_id = NULL, proposed_at = NULL, proposal_note = NULL WHERE id = ?`, [schedule.id]);
  await logAudit(conn, { id: schedule.id, userId: req.user.id, fieldName: 'revision', newValue: 'Withdrawn' });
  return null;
}));

// Design: approve the calendar. With no revision it is approved and assigned now; with revisions it
// goes back to the SBU to approve them.
router.post('/batches/:id/approve', requireAuth, requirePermission(ROUTE, 'can_edit'), withBatch(async ({ conn, batch, side, req }) => {
  if (!side.design) return [403, 'Only a Design Supervisor approves the calendar.'];
  if (batch.status !== BATCH_WITH_DESIGN) return [409, `This calendar is ${batch.status}.`];
  if (!batch.items.length) return [409, 'This calendar has nothing left on it.'];
  const missing = batch.items.find((s) => !s.plan_layout_job_type_id || !(Number(s.plan_layout_qty) > 0));
  if (missing) return [400, `Set the Layout - Job Type and Qty of ${missing.order_no} first.`];
  await conn.query('UPDATE design_schedule_batches SET reviewed_by_user_id = ?, reviewed_at = NOW(), return_note = NULL WHERE id = ?', [req.user.id, batch.id]);
  const revised = batch.items.filter((s) => s.proposed_by_side === 'DESIGN');
  if (revised.length) {
    await conn.query('UPDATE design_schedule_batches SET status = ? WHERE id = ?', [BATCH_WITH_SBU, batch.id]);
    await notifyUsers(conn, [batch.forwarded_by_user_id], {
      title: `Design revised ${revised.length} slot(s) on calendar #${batch.id} -- please approve`,
      message: revised.map((s) => s.order_no).join(', ').slice(0, 500),
      relatedType: 'DesignScheduleBatch', relatedId: batch.id,
    });
    return null;
  }
  return approveBatch(conn, batch, req.user.id).then((err) => (err ? [409, err] : null));
}));

// SBU: approve Design's revisions -- they take effect and the calendar is approved and assigned.
router.post('/batches/:id/accept', requireAuth, requirePermission(ROUTE, 'can_edit'), withBatch(async ({ conn, batch, side, req }) => {
  if (!side.sbu) return [403, 'Only the SBU approves Design\'s revisions.'];
  if (batch.status !== BATCH_WITH_SBU) return [409, `This calendar is ${batch.status}, not waiting on the SBU.`];
  for (const s of batch.items.filter((x) => x.proposed_by_side === 'DESIGN')) {
    const artistId = s.proposed_artist_id || s.preferred_artist_id;
    await conn.query(
      `UPDATE design_schedules SET scheduled_start = ?, scheduled_end = ?, preferred_artist_id = ?, proposed_start = NULL, proposed_end = NULL,
              proposed_artist_id = NULL, proposed_by_side = NULL, proposed_by_user_id = NULL, proposed_at = NULL, proposal_note = NULL WHERE id = ?`,
      [s.proposed_start, s.proposed_end, artistId, s.id],
    );
    await logAudit(conn, {
      id: s.id, userId: req.user.id, fieldName: 'revision accepted',
      oldValue: `${s.scheduled_start} - ${s.scheduled_end}, ${s.preferred_artist_name || ''}`,
      newValue: `${s.proposed_start} - ${s.proposed_end}, ${s.proposed_artist_name || s.preferred_artist_name || ''}`,
    });
    Object.assign(s, { scheduled_start: s.proposed_start, scheduled_end: s.proposed_end, preferred_artist_id: artistId });
  }
  const err = await approveBatch(conn, batch, req.user.id);
  return err ? [409, err] : null;
}));

// SBU: send the calendar back to Design, revisions turned down, with a note why.
router.post('/batches/:id/return', requireAuth, requirePermission(ROUTE, 'can_edit'), withBatch(async ({ conn, batch, side, req }) => {
  if (!side.sbu) return [403, 'Only the SBU answers Design\'s revisions.'];
  if (batch.status !== BATCH_WITH_SBU) return [409, `This calendar is ${batch.status}, not waiting on the SBU.`];
  const note = String(req.body?.note || '').trim();
  if (!note) return [400, 'Say why, so Design knows what to change.'];
  await conn.query(
    `UPDATE design_schedules SET proposed_start = NULL, proposed_end = NULL, proposed_artist_id = NULL, proposed_by_side = NULL,
            proposed_by_user_id = NULL, proposed_at = NULL, proposal_note = NULL WHERE batch_id = ? AND status = 'For Approval'`, [batch.id]);
  await conn.query('UPDATE design_schedule_batches SET status = ?, return_note = ? WHERE id = ?', [BATCH_WITH_DESIGN, note, batch.id]);
  await notifyUsers(conn, [batch.reviewed_by_user_id].filter((u) => Number(u) !== side.userId), {
    title: `The SBU returned calendar #${batch.id} -- revisions not approved`, message: note,
    relatedType: 'DesignScheduleBatch', relatedId: batch.id,
  });
  return null;
}));

// AFTER APPROVAL. Puts new dates into force; the artist's planned window moves with them -- same
// length, new start -- since the assignment took its Planned Start from this slot.
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
  const minutes = schedule.planned_end_at
    ? (new Date(`${String(schedule.planned_end_at).replace(' ', 'T')}Z`) - new Date(`${String(schedule.planned_start_at).replace(' ', 'T')}Z`)) / 60000
    : null;
  const plannedEnd = minutes === null ? null : addMinutes(start, minutes);
  const table = schedule.order_type === 'JO' ? 'job_orders' : 'non_standard_job_orders';
  await conn.query(`UPDATE ${table} SET planned_start_at = ?, planned_end_at = ?, updated_at = NOW() WHERE id = ?`, [start, plannedEnd, schedule.order_id]);
  await logOrderAudit(conn, schedule.order_type, schedule.order_id, userId, 'planned_start_at', schedule.planned_start_at, start);
  await notifyAssignedArtist(conn, {
    artistEmployeeId: schedule.artist_id,
    title: `${schedule.order_no} was rescheduled to ${displaySlot(start, end)}`,
    relatedType: 'DesignSchedule', relatedId: schedule.id, type: NOTIFY_TYPE,
  });
}

const sbuRecipients = (s) => [s.created_by_user_id, s.forwarded_by_user_id];

// Either side moves an approved slot. It stays a proposal until the other side accepts: Design's move
// waits on the SBU, the SBU's on Design.
router.post('/:id/reschedule', requireAuth, requirePermission(ROUTE, 'can_edit'), withSchedule(async ({ conn, schedule, side, req }) => {
  if (!side.sbu && !side.design) return [403, 'Only the SBU or a Design Supervisor can reschedule.'];
  if (schedule.status !== 'Confirmed') return [409, `Only an approved slot is rescheduled -- this one is ${schedule.status}.`];
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
    await notifyUsers(conn, sbuRecipients(schedule), { title, message: note, relatedId: schedule.id });
  } else {
    await notifyDesignSupervisors(conn, { title, message: note, relatedType: 'DesignSchedule', relatedId: schedule.id, excludeUserId: req.user.id, type: NOTIFY_TYPE });
  }
  return null;
}));

// The other side answers a proposal on an approved slot; the proposer may withdraw their own.
function proposalGate(schedule, side, { proposer }) {
  if (schedule.status !== 'Confirmed' || !schedule.proposed_by_side) return [409, 'There is no pending reschedule on this slot.'];
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
    title: `New time for ${schedule.order_no} accepted: ${displaySlot(schedule.proposed_start, schedule.proposed_end)}`, relatedId: schedule.id,
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
    message: reason, relatedId: schedule.id,
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
