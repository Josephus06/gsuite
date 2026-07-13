const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { isScopedToDesignQueue, DESIGN_QUEUE_STATUS, DESIGN_QUEUE_SUB_STATUSES } = require('../lib/designSupervisorVisibility');

const router = express.Router();
const ROUTE = '/job-orders';

// Fields editable via the real system's full-page "Edit" form. Quantity/Length/Width/
// Height are shown there as read-only labels (not inputs) even though this build
// stores them -- matching that, they're intentionally left out of this list. Customer/
// Job Type/Sales Division/Office Location stay locked to the originating Sales Order;
// contact/shipping/delivery/sales-rep details were seeded from it at Create-JO time but
// are independently editable from here on, same as the real form.
const EDIT_FIELDS = [
  'job_location_id', 'description', 'artist_id', 'memo',
  'contact_email', 'contact_title', 'contact_phone', 'shipping_address',
  'delivery_date', 'delivery_time', 'planned_start_date', 'planned_end_date', 'sales_rep_id',
];

// Fields editable per row on the Materials tab.
const PROCESS_FIELDS = [
  'process_id', 'process_qty', 'process_uom', 'category', 'parts', 'item_id', 'location_id',
  'artist_remarks', 'length', 'width', 'uom', 'qty', 'total', 'unit', 'remarks', 'memo',
];

async function logAudit(conn, { jobOrderId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('JobOrder', ?, ?, ?, ?, ?, ?)`,
    [jobOrderId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Mirrors the real system's "Saved Job Orders" list -- a flat table (no status tabs)
// with a filter panel, since job orders don't move through the same tab-per-stage
// pattern Estimates/Sales Orders use.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const {
      search, sales_rep_id: salesRepId, job_location_id: jobLocationId, office_location_id: officeLocationId,
      department_id: departmentId, customer_id: customerId, as_of: asOf, page = '1', limit = '10',
    } = req.query;

    const where = [];
    const params = [];
    if (salesRepId) { where.push('so.sales_rep_id = ?'); params.push(salesRepId); }
    if (jobLocationId) { where.push('jo.job_location_id = ?'); params.push(jobLocationId); }
    if (officeLocationId) { where.push('so.office_location_id = ?'); params.push(officeLocationId); }
    if (departmentId) { where.push('so.sales_division_id = ?'); params.push(departmentId); }
    if (customerId) { where.push('so.customer_id = ?'); params.push(customerId); }
    if (asOf) { where.push('jo.created_at <= ?'); params.push(asOf); }
    if (search) {
      where.push('(jo.job_order_no LIKE ? OR so.sales_order_no LIKE ? OR c.name LIKE ? OR jo.description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    // A Design Supervisor only ever sees their own design queue -- JOs still in "For
    // Design Supervisor" (awaiting an artist assignment from them) or "For Artist"
    // (already assigned, still in layout) -- not the full Job Orders list.
    if (await isScopedToDesignQueue(req.user.id)) {
      where.push('jo.status = ? AND jo.sub_status IN (?)');
      params.push(DESIGN_QUEUE_STATUS, DESIGN_QUEUE_SUB_STATUSES);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const baseFrom = `FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN locations jloc ON jloc.id = jo.job_location_id
       LEFT JOIN locations oloc ON oloc.id = so.office_location_id
       LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN employees pb ON pb.id = so.prepared_by_id
       LEFT JOIN employees ar ON ar.id = jo.artist_id`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${whereSql}`, params);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.query(
      `SELECT jo.*, so.sales_order_no, c.name AS customer_name, cc.contact_name,
              jt.display_name AS job_type_name, jloc.location_name AS job_location_name,
              oloc.location_name AS office_location_name, sd.name AS sales_division_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(pb.first_name, ' ', pb.last_name) AS prepared_by_name,
              CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name
       ${baseFrom} ${whereSql}
       ORDER BY jo.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({ rows, total, page: pageNum, limit: limitNum });
  } catch (err) {
    next(err);
  }
});

// Deliberately minimal: this is where a Sales Order line's "Create JO" link leads, not
// a full Job Order/Production module (no job execution, QI, delivery, or invoicing
// tracking here).
router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[jo]] = await pool.query(
      `SELECT jo.*, so.sales_order_no, so.status AS sales_order_status, so.office_location_id, so.sales_division_id,
              so.production_lead_time,
              sol.subtotal AS line_subtotal, sol.disc_amount AS line_disc_amount,
              c.name AS customer_name, cc.contact_name,
              jt.display_name AS job_type_name, loc.location_name AS job_location_name,
              oloc.location_name AS office_location_name, sd.name AS sales_division_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name,
              ljt.display_name AS layout_job_type_name
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN sales_order_lines sol ON sol.id = jo.sales_order_line_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN locations oloc ON oloc.id = so.office_location_id
       LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
       LEFT JOIN employees sr ON sr.id = jo.sales_rep_id
       LEFT JOIN employees ar ON ar.id = jo.artist_id
       LEFT JOIN pms_job_types ljt ON ljt.id = jo.layout_job_type_id
       WHERE jo.id = ?`,
      [req.params.id]
    );
    if (!jo) return res.status(404).json({ error: 'Not found' });
    // Defense in depth -- a Design Supervisor can't view a JO outside their design
    // queue just by guessing/pasting its URL, even though the list already filters it.
    if (await isScopedToDesignQueue(req.user.id)) {
      if (jo.status !== DESIGN_QUEUE_STATUS || !DESIGN_QUEUE_SUB_STATUSES.includes(jo.sub_status)) {
        return res.status(404).json({ error: 'Not found' });
      }
    }

    const [processes] = await pool.query(
      `SELECT jop.*, pr.process_name, i.display_name AS item_name, loc.location_name
       FROM job_order_processes jop
       LEFT JOIN processes pr ON pr.id = jop.process_id
       LEFT JOIN inventories i ON i.id = jop.item_id
       LEFT JOIN locations loc ON loc.id = jop.location_id
       WHERE jop.job_order_id = ? ORDER BY jop.line_no`,
      [req.params.id]
    );

    res.json({ ...jo, processes });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'JobOrder' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Real system's "Edit" button -- shown there whenever the JO isn't Cancelled and the
// user can edit; only the production-side fields captured on the JO itself are
// editable (customer/sales details stay derived from the Sales Order).
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[oldRow]] = await conn.query('SELECT * FROM job_orders WHERE id = ?', [req.params.id]);
    if (!oldRow) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    if (oldRow.status === 'Cancelled') {
      await conn.rollback();
      return res.status(409).json({ error: 'A cancelled Job Order cannot be edited' });
    }
    if (req.body.planned_start_date && req.body.planned_end_date && req.body.planned_end_date < req.body.planned_start_date) {
      await conn.rollback();
      return res.status(400).json({ error: 'Planned End cannot be before Planned Start.' });
    }
    // This generic edit form resubmits artist_id on every save whether or not it
    // actually changed (it's just part of the form state) -- only enforce the Design
    // Supervisor restriction when the value is genuinely different from what's stored,
    // same restriction already enforced on the dedicated assign-design endpoint.
    const requestedArtistId = req.body.artist_id === undefined || req.body.artist_id === '' ? null : Number(req.body.artist_id);
    const currentArtistId = oldRow.artist_id === null || oldRow.artist_id === undefined ? null : Number(oldRow.artist_id);
    if (requestedArtistId !== currentArtistId) {
      const [[user]] = await conn.query('SELECT is_design_supervisor FROM users WHERE id = ?', [req.user.id]);
      if (!user?.is_design_supervisor) {
        await conn.rollback();
        return res.status(403).json({ error: 'Only a Design Supervisor can assign an artist to a Job Order.' });
      }
    }
    const values = EDIT_FIELDS.map((f) => (req.body[f] === undefined || req.body[f] === '' ? null : req.body[f]));

    // Setting both Planned dates is what "scheduling" this JO means on the production
    // floor -- once it has a plan, it's no longer just sitting in the Pending for
    // Scheduling tab. Only auto-advances from that specific stage, so it never clobbers
    // a JO that's already further along (For QI, Completed, etc.) if planned dates get
    // edited later.
    const schedulingNow = req.body.planned_start_date && req.body.planned_end_date
      && oldRow.production_stage === 'pending_for_scheduling';

    await conn.query(
      `UPDATE job_orders SET ${EDIT_FIELDS.map((f) => `${f} = ?`).join(', ')}${schedulingNow ? ", production_stage = 'in_process'" : ''}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.id]
    );
    for (let i = 0; i < EDIT_FIELDS.length; i++) {
      const f = EDIT_FIELDS[i];
      const oldVal = oldRow[f] === null ? null : String(oldRow[f]);
      const newVal = values[i] === null ? null : String(values[i]);
      if (oldVal === newVal) continue;
      await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: f, oldValue: oldVal, newValue: newVal });
    }
    if (schedulingNow) {
      await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'production_stage', oldValue: 'pending_for_scheduling', newValue: 'in_process' });
    }
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM job_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Hold/Resume are a toggle pair on the real system (only one shows at a time, based on
// IsOnHold) -- pausing/resuming production on a JO that isn't Completed or Cancelled.
router.put('/:id/hold', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT status, is_on_hold FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }
    if (jo.status === 'Completed' || jo.status === 'Cancelled') {
      await conn.rollback();
      return res.status(409).json({ error: `A ${jo.status.toLowerCase()} Job Order cannot be put on hold` });
    }
    await conn.query('UPDATE job_orders SET is_on_hold = TRUE, updated_at = NOW() WHERE id = ?', [req.params.id]);
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'is_on_hold', oldValue: '0', newValue: '1' });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM job_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/resume', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT status, is_on_hold FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }
    await conn.query('UPDATE job_orders SET is_on_hold = FALSE, updated_at = NOW() WHERE id = ?', [req.params.id]);
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'is_on_hold', oldValue: '1', newValue: '0' });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM job_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Mirrors the real system's "Forward to Design Supervisor" button: shown while a
// freshly-created JO's Sub Status is still "Pending", and clicking it sends the JO into
// the design-review queue (Sub Status -> "For Design Supervisor"). Main Status stays
// "Planned - Pending for BOM" throughout -- only the Sub Status changes.
router.put('/:id/forward-to-design', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT sub_status FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }
    if (jo.sub_status !== 'Pending') {
      await conn.rollback();
      return res.status(409).json({ error: 'This Job Order is not in the Pending queue' });
    }
    await conn.query("UPDATE job_orders SET sub_status = 'For Design Supervisor', updated_at = NOW() WHERE id = ?", [req.params.id]);
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'sub_status', oldValue: 'Pending', newValue: 'For Design Supervisor' });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM job_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Design supervisors assign a Layout - Job Type (PMS Job Type) + Artist to a JO once
// it's reached the design-review queue; doing so hands it off to the artist (Sub Status
// -> "For Artist"). Requires the Can Approve-style role flag on the user, same pattern
// as can_approve_sales_estimate for Estimates -- not gated by the generic can_edit
// permission alone.
router.put('/:id/assign-design', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const [[user]] = await pool.query('SELECT is_design_supervisor FROM users WHERE id = ?', [req.user.id]);
  if (!user?.is_design_supervisor) {
    return res.status(403).json({ error: 'Only a Design Supervisor can assign layout job type and artist.' });
  }

  const { layout_job_type_id, artist_id, planned_start_at, layout_qty: layoutQtyRaw } = req.body;
  if (!layout_job_type_id || !artist_id || !planned_start_at) {
    return res.status(400).json({ error: 'Layout - Job Type, Artist, and Planned Start are all required.' });
  }
  const layoutQty = Number(layoutQtyRaw);
  if (!Number.isFinite(layoutQty) || layoutQty <= 0) {
    return res.status(400).json({ error: 'Qty must be a positive number.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT sub_status FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }
    if (jo.sub_status !== 'For Design Supervisor') {
      await conn.rollback();
      return res.status(409).json({ error: 'This Job Order is not pending design supervisor assignment.' });
    }

    const [[pmsJobType]] = await conn.query('SELECT minutes_consume FROM pms_job_types WHERE id = ?', [layout_job_type_id]);
    if (!pmsJobType) { await conn.rollback(); return res.status(400).json({ error: 'Invalid Layout - Job Type.' }); }

    // Planned End = Planned Start + (the PMS Job Type's allotted minutes_consume x Qty)
    // -- minutes_consume is the allotment for one unit of this layout task, so a Qty of
    // e.g. 5 files/designs scales the allotted time (and, downstream, the Assigned JO
    // countdown timer and Performance % basis) proportionally.
    const plannedEndAt = new Date(new Date(planned_start_at).getTime() + Number(pmsJobType.minutes_consume || 0) * layoutQty * 60 * 1000);

    await conn.query(
      "UPDATE job_orders SET layout_job_type_id = ?, artist_id = ?, planned_start_at = ?, planned_end_at = ?, layout_qty = ?, sub_status = 'For Artist', updated_at = NOW() WHERE id = ?",
      [layout_job_type_id, artist_id, planned_start_at, plannedEndAt, layoutQty, req.params.id]
    );
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'layout_job_type_id', newValue: layout_job_type_id });
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'artist_id', newValue: artist_id });
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'planned_start_at', newValue: planned_start_at });
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'layout_qty', newValue: layoutQty });
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'planned_end_at', newValue: plannedEndAt.toISOString() });
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'sub_status', oldValue: 'For Design Supervisor', newValue: 'For Artist' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM job_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Once the artist has done the layout (Sub Status "For Artist", or "For Artist
// (Revision)" after a bounce-back), this sends it to Sales for sign-off.
//
// Reachable by anyone with generic can_edit on Job Orders, OR by the specific artist
// this JO is assigned to even without it -- they need to be able to send their own
// completed layout for sign-off without getting broader edit rights over the JO itself
// (the artist_id lock on the generic PUT /:id route above still applies to them).
router.put('/:id/sales-approval', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT sub_status, artist_id FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }

    const [[me]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    const isAssignedArtist = !!me?.employee_id && jo.artist_id === me.employee_id;
    if (!isAssignedArtist) {
      const [[page]] = await conn.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
      const [[perm]] = await conn.query('SELECT can_edit AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [req.user.id, page?.id]);
      if (!perm?.allowed) {
        await conn.rollback();
        return res.status(403).json({ error: 'You do not have permission to perform this action' });
      }
    }

    if (jo.sub_status !== 'For Artist' && jo.sub_status !== 'For Artist (Revision)') {
      await conn.rollback();
      return res.status(409).json({ error: 'This Job Order is not ready for Sales Approval.' });
    }
    await conn.query("UPDATE job_orders SET sub_status = 'Sales Approval', updated_at = NOW() WHERE id = ?", [req.params.id]);
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'sub_status', oldValue: jo.sub_status, newValue: 'Sales Approval' });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM job_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Sales sign-off: "Approved" releases the JO for production; "For Revision" bounces it
// back to the artist, from where Sales Approval can be requested again.
router.put('/:id/approve-sales', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT sub_status FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }
    if (jo.sub_status !== 'Sales Approval') {
      await conn.rollback();
      return res.status(409).json({ error: 'This Job Order is not pending Sales Approval.' });
    }
    // Releasing also forwards the JO into the "Production" module's own stage-tracking
    // pipeline (Pending for Sched. -> ... -> Completed/Invoiced), separate from this
    // Status/Sub Status pair.
    await conn.query(
      "UPDATE job_orders SET status = 'Released', sub_status = 'Approved', production_stage = 'pending_for_scheduling', date_forwarded = NOW(), updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'status', oldValue: 'Planned - Pending for BOM', newValue: 'Released' });
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'sub_status', oldValue: 'Sales Approval', newValue: 'Approved' });
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'production_stage', newValue: 'pending_for_scheduling' });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM job_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/request-revision', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT sub_status FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }
    if (jo.sub_status !== 'Sales Approval') {
      await conn.rollback();
      return res.status(409).json({ error: 'This Job Order is not pending Sales Approval.' });
    }
    // Clears the layout timer (both actual start/end and every recorded Play/Hold
    // session) so the artist's "Assigned JO" performance clock restarts fresh for the
    // revision round instead of continuing to count from the first pass.
    await conn.query("UPDATE job_orders SET sub_status = 'For Artist (Revision)', layout_started_at = NULL, layout_ended_at = NULL, updated_at = NOW() WHERE id = ?", [req.params.id]);
    await conn.query('DELETE FROM job_order_layout_sessions WHERE job_order_id = ?', [req.params.id]);
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'sub_status', oldValue: 'Sales Approval', newValue: 'For Artist (Revision)' });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM job_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// --- Materials tab (job_order_processes rows) --------------------------------

router.post('/:id/processes', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT id FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }
    const [[{ nextLine }]] = await conn.query(
      'SELECT COALESCE(MAX(line_no), 0) + 1 AS nextLine FROM job_order_processes WHERE job_order_id = ?',
      [req.params.id]
    );
    const values = PROCESS_FIELDS.map((f) => (req.body[f] === undefined || req.body[f] === '' ? null : req.body[f]));
    const [result] = await conn.query(
      `INSERT INTO job_order_processes (job_order_id, line_no, ${PROCESS_FIELDS.join(', ')})
       VALUES (?, ?, ${PROCESS_FIELDS.map(() => '?').join(', ')})`,
      [req.params.id, nextLine, ...values]
    );
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Created', fieldName: `material[${nextLine}]` });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM job_order_processes WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/processes/:procId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[oldRow]] = await conn.query(
      'SELECT * FROM job_order_processes WHERE id = ? AND job_order_id = ?',
      [req.params.procId, req.params.id]
    );
    if (!oldRow) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }
    const values = PROCESS_FIELDS.map((f) => (req.body[f] === undefined || req.body[f] === '' ? null : req.body[f]));
    await conn.query(
      `UPDATE job_order_processes SET ${PROCESS_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      [...values, req.params.procId]
    );
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM job_order_processes WHERE id = ?', [req.params.procId]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id/processes/:procId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.query(
      'SELECT line_no FROM job_order_processes WHERE id = ? AND job_order_id = ?',
      [req.params.procId, req.params.id]
    );
    if (!row) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }
    await conn.query('DELETE FROM job_order_processes WHERE id = ?', [req.params.procId]);
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Deleted', fieldName: `material[${row.line_no}]` });
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
