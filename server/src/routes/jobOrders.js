const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, isSystemAdmin } = require('../middleware/auth');
const { isScopedToDesignQueue, DESIGN_QUEUE_STATUS, DESIGN_QUEUE_SUB_STATUSES } = require('../lib/designSupervisorVisibility');
const { getArtistEmployeeScope } = require('../lib/artistVisibility');
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');
const { getJobLocationScope, isJobLocationVisible } = require('../lib/jobLocationVisibility');
const {
  notifyDesignSupervisors, notifyAssignedArtist, notifySalesRep, NOTIFY_TYPE_JO_REVISION,
} = require('../lib/designNotifications');
const {
  maySalesReviseJobOrder, isOpenForSalesRework, REWORK_PROTECTED_FIELDS,
} = require('../lib/jobOrderRevision');

const router = express.Router();
const ROUTE = '/job-orders';

// Who may be assigned layout work. account_type lives on the USER account, not the employee
// record, so this is checked by joining through users.employee_id -- the same definition the
// assignment picker filters by (GET /employees?account_type=Artist) and the Artist Incentive
// report's filter uses.
const ARTIST_ACCOUNT_TYPE = 'Artist';

// The "Saved Job Orders" status tabs, mirroring the live list. A JO lands in exactly one: Hold wins
// over everything; otherwise released JOs go by production_stage and pre-release JOs by sub_status
// (the Design/Layout/Sales-approval workflow), with "Update JO" the catch-all for a freshly created
// (Pending) JO. Each `cond` is a trusted literal (no user input) so it's inlined directly.
const JO_TABS = [
  { key: 'update_jo', label: 'Update JO', cond: "jo.is_on_hold = 0 AND jo.production_stage IS NULL AND (jo.sub_status IS NULL OR jo.sub_status NOT IN ('For Design Supervisor','For Artist','For Artist (Revision)','Sales Approval'))" },
  { key: 'for_design_sup', label: 'For Design Sup.', cond: "jo.is_on_hold = 0 AND jo.sub_status = 'For Design Supervisor'" },
  { key: 'for_artist', label: 'For Artist', cond: "jo.is_on_hold = 0 AND jo.sub_status = 'For Artist'" },
  { key: 'pending_for_rev', label: 'Pending for Rev.', cond: "jo.is_on_hold = 0 AND jo.sub_status = 'For Artist (Revision)'" },
  { key: 'for_approval', label: 'For Approval', cond: "jo.is_on_hold = 0 AND jo.sub_status = 'Sales Approval'" },
  { key: 'pending_for_sched', label: 'Pending for Sched.', cond: "jo.is_on_hold = 0 AND jo.production_stage = 'pending_for_scheduling'" },
  { key: 'for_rev', label: 'For Rev.', cond: "jo.is_on_hold = 0 AND jo.production_stage = 'for_revision'" },
  { key: 'in_process_w_rev', label: 'In-Process w/ Rev.', cond: "jo.is_on_hold = 0 AND jo.production_stage = 'in_process_with_revision'" },
  { key: 'in_process', label: 'In-Process', cond: "jo.is_on_hold = 0 AND jo.production_stage = 'in_process'" },
  { key: 'for_qi', label: 'For QI', cond: "jo.is_on_hold = 0 AND jo.production_stage = 'for_qi'" },
  { key: 'part_completed', label: 'Part. Completed', cond: "jo.is_on_hold = 0 AND jo.production_stage = 'partially_completed'" },
  { key: 'completed', label: 'Completed', cond: "jo.is_on_hold = 0 AND jo.production_stage = 'completed'" },
  { key: 'invoiced', label: 'Invoiced', cond: "jo.is_on_hold = 0 AND jo.production_stage = 'invoiced'" },
  { key: 'hold', label: 'Hold', cond: 'jo.is_on_hold = 1' },
];
const JO_TAB_MAP = Object.fromEntries(JO_TABS.map((t) => [t.key, t.cond]));

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

// can_edit on /job-orders, OR the narrow grant a "change material/process" revision carries:
// the job order's own sales rep may rework THAT job order for as long as it sits in revision for
// THAT reason. Production asking Sales to re-specify a job is only a request if Sales can act on
// it, and 24 of 27 sales accounts hold can_view alone -- so before this, the standard answer to
// "change the material" was to find someone else to do it.
//
// Returns 'permission' | 'rework' | null, because the two are not equivalent downstream: a rework
// grant is scoped to the spec (see REWORK_PROTECTED_FIELDS) where can_edit is not.
async function jobOrderEditGrant(userId, jobOrderId) {
  const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  const [[perm]] = await pool.query(
    'SELECT can_edit AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?',
    [userId, page?.id]
  );
  if (perm?.allowed) return 'permission';
  if (await isSystemAdmin(userId)) return 'permission';

  const [[jo]] = await pool.query(
    'SELECT sales_rep_id, status, production_stage, revision_reason FROM job_orders WHERE id = ?',
    [jobOrderId]
  );
  if (!jo || !isOpenForSalesRework(jo)) return null;
  const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [userId]);
  if (me?.employee_id && String(jo.sales_rep_id) === String(me.employee_id)) return 'rework';
  return null;
}

// Middleware form, for the routes that only need "may they touch this at all" -- the process
// rows, which ARE the material and the process, so a rework grant opens them completely.
async function requireJobOrderEdit(req, res, next) {
  try {
    const grant = await jobOrderEditGrant(req.user.id, req.params.id);
    if (!grant) return res.status(403).json({ error: 'You do not have permission to perform this action' });
    req.joEditGrant = grant;
    return next();
  } catch (err) { return next(err); }
}

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
      department_id: departmentId, customer_id: customerId, as_of: asOf, tab, page = '1', limit = '10',
    } = req.query;

    const where = [];
    const params = [];
    // A production department only sees its own warehouse's job orders. This is a ceiling, not
    // one more scope to choose between: it stacks with the design-queue/artist rules below rather
    // than replacing them, and it goes into `where` so the status tab counts inherit it too.
    const scopeLocationId = await getJobLocationScope(req.user.id);
    if (scopeLocationId) { where.push('jo.job_location_id = ?'); params.push(scopeLocationId); }
    if (salesRepId) { where.push('so.sales_rep_id = ?'); params.push(salesRepId); }
    // Scoped on the job order's OWN rep, not the sales order's. The two agree on every one of
    // the 124,300 rows, but a job order can exist without a sales order at all (NSJO, RWIP), and
    // scoping through the join would make those invisible to everyone rather than to nobody.
    const salesScope = await getSalesRepEmployeeScope(req.user.id);
    if (salesScope) { where.push('jo.sales_rep_id IN (?)'); params.push(salesScope); }
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
    } else {
      // An Artist sees only the Job Orders assigned to them. Without this they match no
      // filter at all (they are neither an Account Officer nor a Supervisor) and see the
      // entire list.
      const artistEmployeeId = await getArtistEmployeeScope(req.user.id);
      if (artistEmployeeId) {
        where.push('jo.artist_id = ?');
        params.push(artistEmployeeId);
      }
    }
    // The tab counts run over every filter EXCEPT the status tab itself, so each tab always shows its
    // full total regardless of which one is active. The listing/total additionally narrow to the
    // picked tab's condition.
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const listWhere = [...where];
    const listParams = [...params];
    if (tab && JO_TAB_MAP[tab]) listWhere.push(`(${JO_TAB_MAP[tab]})`);
    const listWhereSql = listWhere.length ? `WHERE ${listWhere.join(' AND ')}` : '';

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

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${listWhereSql}`, listParams);

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
       ${baseFrom} ${listWhereSql}
       ORDER BY jo.id DESC
       LIMIT ? OFFSET ?`,
      [...listParams, limitNum, offset]
    );

    // One pass tallies every tab (a SUM/CASE per tab), so the counts are always consistent with the
    // same conditions used to filter the listing.
    const countSelect = JO_TABS.map((t) => `SUM(CASE WHEN ${t.cond} THEN 1 ELSE 0 END) AS ${t.key}`).join(', ');
    const [[countRow]] = await pool.query(`SELECT COUNT(*) AS all_count, ${countSelect} ${baseFrom} ${whereSql}`, params);
    const counts = { all: Number(countRow.all_count) || 0 };
    JO_TABS.forEach((t) => { counts[t.key] = Number(countRow[t.key]) || 0; });

    res.json({ rows, total, page: pageNum, limit: limitNum, counts });
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
              ljt.display_name AS layout_job_type_name,
              nsso.nsso_no, rc.name AS reason_code_name,
              CONCAT(rap.first_name, ' ', rap.last_name) AS rma_approved_by_name,
              pjo.job_order_no AS parent_job_order_no,
              rqu.display_name AS revision_requested_by_name
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
       LEFT JOIN non_standard_sales_orders nsso ON nsso.id = jo.nsso_id
       LEFT JOIN reasons rc ON rc.id = jo.reason_code_id
       LEFT JOIN employees rap ON rap.id = jo.rma_approved_by_id
       LEFT JOIN job_orders pjo ON pjo.id = jo.parent_job_order_id
       LEFT JOIN users rqu ON rqu.id = jo.revision_requested_by_id
       WHERE jo.id = ?`,
      [req.params.id]
    );
    if (!jo) return res.status(404).json({ error: 'Not found' });
    // Defence in depth for the list filter above: hiding a document from the list while still
    // serving it to anyone who types its id is not a restriction. See lib/salesVisibility.js.
    const salesScope = await getSalesRepEmployeeScope(req.user.id);
    if (salesScope && !salesScope.includes(jo.sales_rep_id)) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Same defense in depth as the design-queue check below, for the department's warehouse:
    // 404, so an out-of-department JO reads as one that isn't there.
    if (!isJobLocationVisible(jo, await getJobLocationScope(req.user.id))) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Defense in depth -- a Design Supervisor can't view a JO outside their design
    // queue just by guessing/pasting its URL, even though the list already filters it.
    if (await isScopedToDesignQueue(req.user.id)) {
      if (jo.status !== DESIGN_QUEUE_STATUS || !DESIGN_QUEUE_SUB_STATUSES.includes(jo.sub_status)) {
        return res.status(404).json({ error: 'Not found' });
      }
    } else {
      const artistEmployeeId = await getArtistEmployeeScope(req.user.id);
      if (artistEmployeeId && String(jo.artist_id) !== String(artistEmployeeId)) {
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

    // RWIP (rework) job orders raised off this JO -- listed on the RWIP JO tab.
    const [rwips] = await pool.query(
      `SELECT id, job_order_no, created_at, quantity, units, status, production_stage
       FROM job_orders WHERE parent_job_order_id = ? ORDER BY id DESC`,
      [req.params.id]
    );

    res.json({ ...jo, processes, rwips });
  } catch (err) {
    next(err);
  }
});

// Approve RMA -- releases an NSSO-spawned job order from "Pending RMA Approval" into the normal
// production flow. Gated by the NSSO page's can_approve permission (the same "NSSO Can Approve"
// right that lets a user approve the Non-Standard Sales Order also approves its rework JOs).
router.put('/:id/approve-rma', requireAuth, requirePermission('/non-standard-sales-orders', 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[jo]] = await conn.query('SELECT id, nsso_id, rma_approved_at FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) return res.status(404).json({ error: 'Not found' });
    if (!jo.nsso_id) return res.status(409).json({ error: 'This job order is not an RMA job order.' });
    if (jo.rma_approved_at) return res.status(409).json({ error: 'This RMA job order is already approved.' });
    const [[u]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    await conn.beginTransaction();
    // Approving the RMA moves it to "Planned - Pending for BOM" but NOT yet into production --
    // an NSJO has no design/layout step, so from here the only remaining action is the explicit
    // "Forward to Production" (below), which Releases it. production_stage stays NULL until then.
    await conn.query(
      "UPDATE job_orders SET rma_approved_at = NOW(), rma_approved_by_id = ?, status = 'Planned - Pending for BOM' WHERE id = ?",
      [u?.employee_id || null, req.params.id]
    );
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Approved', fieldName: 'status', oldValue: 'Pending RMA Approval', newValue: 'Planned - Pending for BOM' });
    await conn.commit();
    const [[updated]] = await pool.query('SELECT * FROM job_orders WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Forward an approved RMA job order to production. NSJOs skip the whole design/layout/scheduling
// chain a standard JO goes through -- this single step Releases it straight into production
// (status "Released / Approved", production_stage in_process) so it's immediately buildable and
// quality-inspectable like any other production JO. Gated by the same NSSO "Can Approve" right.
router.put('/:id/forward-to-production', requireAuth, requirePermission('/non-standard-sales-orders', 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[jo]] = await conn.query('SELECT id, nsso_id, rma_approved_at, status FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) return res.status(404).json({ error: 'Not found' });
    if (!jo.nsso_id) return res.status(409).json({ error: 'This job order is not an RMA job order.' });
    if (!jo.rma_approved_at) return res.status(409).json({ error: 'Approve the RMA before forwarding to production.' });
    if (jo.status === 'Released') return res.status(409).json({ error: 'Already forwarded to production.' });
    if (jo.status === 'Cancelled') return res.status(409).json({ error: 'This job order is cancelled.' });
    await conn.beginTransaction();
    await conn.query(
      "UPDATE job_orders SET status = 'Released', sub_status = 'Approved', production_stage = 'in_process', date_forwarded = NOW(), updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'status', oldValue: jo.status, newValue: 'Released' });
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'sub_status', newValue: 'Approved' });
    await conn.commit();
    const [[updated]] = await pool.query('SELECT * FROM job_orders WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Approve an RWIP (rework) job order -- gated by the PRODUCTION page's can_approve ("who can approve
// RWIP"), distinct from NSSO approval. One step: "Pending RMA Approval" -> Released / In-Process, so
// it lands on the production floor to be worked and completed.
router.put('/:id/approve-rwip', requireAuth, requirePermission('/production', 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[jo]] = await conn.query('SELECT id, parent_job_order_id, status FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) return res.status(404).json({ error: 'Not found' });
    if (!jo.parent_job_order_id) return res.status(409).json({ error: 'This job order is not an RWIP.' });
    if (jo.status !== 'Pending RMA Approval') return res.status(409).json({ error: 'This RWIP is not pending approval.' });
    const [[u]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    await conn.beginTransaction();
    await conn.query(
      "UPDATE job_orders SET rma_approved_at = NOW(), rma_approved_by_id = ?, status = 'Released', sub_status = 'Approved', production_stage = 'in_process', date_forwarded = NOW(), updated_at = NOW() WHERE id = ?",
      [u?.employee_id || null, req.params.id]
    );
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Approved', fieldName: 'status', oldValue: 'Pending RMA Approval', newValue: 'Released' });
    await conn.commit();
    const [[updated]] = await pool.query('SELECT * FROM job_orders WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
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
router.put('/:id', requireAuth, requireJobOrderEdit, async (req, res, next) => {
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
      // Same cutoff as the dedicated assign-design endpoint -- once Released, the
      // design/artist stage is over, so this generic edit form can't be used as a
      // side door to reassign an artist after the fact.
      if (oldRow.status === 'Released') {
        await conn.rollback();
        return res.status(409).json({ error: 'This Job Order is Released -- the artist can no longer be reassigned.' });
      }
    }
    // A rework grant re-specifies the job; it does not re-plan or reassign it. The form posts
    // every field it holds, so this checks for an actual CHANGE rather than for presence --
    // the same way the artist_id rule just above works. Refused loudly instead of quietly
    // dropped: a save that silently keeps the old date would read as the app losing the edit.
    if (req.joEditGrant === 'rework') {
      const changed = REWORK_PROTECTED_FIELDS.filter((f) => {
        if (req.body[f] === undefined) return false;
        const before = oldRow[f] === null || oldRow[f] === undefined ? '' : String(oldRow[f]);
        const after = req.body[f] === null || req.body[f] === '' ? '' : String(req.body[f]);
        // Dates arrive as 'YYYY-MM-DD' from the form but may be stored with a time component.
        return before.slice(0, after.length || before.length) !== after && before !== after;
      });
      if (changed.length) {
        await conn.rollback();
        return res.status(403).json({
          error: `While this Job Order is for revision you can change its materials and processes, not ${changed.join(', ')}.`,
        });
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
// Reachable by anyone with generic can_edit on Job Orders, OR by the specific sales rep
// this JO belongs to even without it -- a sales rep needs to be able to forward their
// own job orders into the design queue without needing broader edit rights over Job
// Orders in general. Same dual-check shape as sales-approval below.
router.put('/:id/forward-to-design', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT job_order_no, description, sub_status, sales_rep_id FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }

    const [[me]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    const isOwningSalesRep = !!me?.employee_id && jo.sales_rep_id === me.employee_id;
    if (!isOwningSalesRep) {
      const [[page]] = await conn.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
      const [[perm]] = await conn.query('SELECT can_edit AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [req.user.id, page?.id]);
      if (!perm?.allowed) {
        await conn.rollback();
        return res.status(403).json({ error: 'You do not have permission to perform this action' });
      }
    }

    if (jo.sub_status !== 'Pending') {
      await conn.rollback();
      return res.status(409).json({ error: 'This Job Order is not in the Pending queue' });
    }
    await conn.query("UPDATE job_orders SET sub_status = 'For Design Supervisor', updated_at = NOW() WHERE id = ?", [req.params.id]);
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'sub_status', oldValue: 'Pending', newValue: 'For Design Supervisor' });
    // Just landed in the design queue with no artist on it -- tell the supervisors rather
    // than relying on someone refreshing the list. Same hand-off as the NSTDJO forward.
    await notifyDesignSupervisors(conn, {
      title: `${jo.job_order_no} needs an artist assigned`,
      message: jo.description ? String(jo.description).slice(0, 500) : null,
      relatedType: 'JobOrder',
      relatedId: req.params.id,
      excludeUserId: req.user.id,
    });
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

// Design supervisors assign (or later reassign) a Layout - Job Type (PMS Job Type) +
// Artist to a JO; doing so hands it off to the artist (Sub Status -> "For Artist").
// Gated on the is_design_supervisor role flag itself (same pattern as
// can_approve_sales_estimate for Estimates), with generic can_edit on Job Orders as a
// fallback override for admins/managers who aren't personally flagged as a design
// supervisor -- previously this ALSO required can_edit unconditionally even for an
// actual design supervisor, which is what made the button unusable for one whose
// account only had can_view. Reassignment is allowed at any point up to Released --
// once a JO's overall status is "Released" (Sales gave final approval, production has
// it), the design/artist stage is over and this closes; Cancelled is likewise final.
router.put('/:id/assign-design', requireAuth, async (req, res, next) => {
  const [[user]] = await pool.query('SELECT is_design_supervisor, employee_id FROM users WHERE id = ?', [req.user.id]);
  if (!user?.is_design_supervisor) {
    const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
    const [[perm]] = await pool.query('SELECT can_edit AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [req.user.id, page?.id]);
    if (!perm?.allowed) {
      return res.status(403).json({ error: 'Only a Design Supervisor can assign layout job type and artist.' });
    }
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
    const [[jo]] = await conn.query('SELECT job_order_no, description, status, sub_status, artist_id FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }
    if (jo.status === 'Released' || jo.status === 'Cancelled') {
      await conn.rollback();
      return res.status(409).json({ error: `This Job Order is ${jo.status} -- the artist can no longer be reassigned.` });
    }

    const [[pmsJobType]] = await conn.query('SELECT minutes_consume FROM pms_job_types WHERE id = ?', [layout_job_type_id]);
    if (!pmsJobType) { await conn.rollback(); return res.status(400).json({ error: 'Invalid Layout - Job Type.' }); }

    // The artist is checked the same way the job type just was. The picker in the UI already
    // lists Artists only, but nothing here enforced it, so any employee id that reached this
    // endpoint was written through -- which is how a System Admin came to hold a Job Order and
    // then to earn a layout incentive on the Artist Incentive report. Client-side filtering is
    // a convenience; this is the rule.
    const [[artist]] = await conn.query(
      `SELECT e.id FROM employees e
         JOIN users u ON u.employee_id = e.id
        WHERE e.id = ? AND u.account_type = ?`,
      [artist_id, ARTIST_ACCOUNT_TYPE],
    );
    if (!artist) {
      await conn.rollback();
      return res.status(400).json({ error: 'That employee is not an Artist -- layout work can only be assigned to an Artist account.' });
    }

    // Planned End = Planned Start + (the PMS Job Type's allotted minutes_consume x Qty)
    // -- minutes_consume is the allotment for one unit of this layout task, so a Qty of
    // e.g. 5 files/designs scales the allotted time (and, downstream, the Assigned JO
    // countdown timer and Performance % basis) proportionally.
    const plannedEndAt = new Date(new Date(planned_start_at).getTime() + Number(pmsJobType.minutes_consume || 0) * layoutQty * 60 * 1000);
    const isReassignment = jo.sub_status !== 'For Design Supervisor';

    await conn.query(
      "UPDATE job_orders SET layout_job_type_id = ?, artist_id = ?, planned_start_at = ?, planned_end_at = ?, layout_qty = ?, sub_status = 'For Artist', layout_started_at = NULL, layout_ended_at = NULL, updated_at = NOW() WHERE id = ?",
      [layout_job_type_id, artist_id, planned_start_at, plannedEndAt, layoutQty, req.params.id]
    );
    // A (re)assignment always restarts the layout clock from zero -- clearing any prior
    // Play/Hold session history, same treatment request-revision already gives a JO
    // bounced back for revision, so a newly (re)assigned artist's Performance % isn't
    // polluted by a previous artist's (or a previous round's) recorded time.
    await conn.query('DELETE FROM job_order_layout_sessions WHERE job_order_id = ?', [req.params.id]);
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'layout_job_type_id', newValue: layout_job_type_id });
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'artist_id', oldValue: jo.artist_id, newValue: artist_id });
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'planned_start_at', newValue: planned_start_at });
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'layout_qty', newValue: layoutQty });
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'planned_end_at', newValue: plannedEndAt.toISOString() });
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'sub_status', oldValue: jo.sub_status, newValue: 'For Artist' });
    if (isReassignment) {
      await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'artist_reassigned', oldValue: jo.artist_id, newValue: artist_id });
    }
    // Tell the artist the work is theirs. Sent on a reassignment too -- the new artist
    // needs telling just as much as the first one did.
    await notifyAssignedArtist(conn, {
      artistEmployeeId: artist_id,
      title: `${jo.job_order_no} has been assigned to you`,
      message: jo.description ? String(jo.description).slice(0, 500) : null,
      relatedType: 'JobOrder',
      relatedId: req.params.id,
    });
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
    const [[jo]] = await conn.query(
      'SELECT sub_status, artist_id, sales_rep_id, job_order_no, layout_ended_at FROM job_orders WHERE id = ?',
      [req.params.id]
    );
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

    // Sales approve against the artist's drawings, so there has to be something to approve.
    // Enforced here rather than only in the UI: the button is one way in, but the endpoint
    // is the rule.
    const [[att]] = await conn.query(
      'SELECT COUNT(*) AS n FROM job_order_attachments WHERE job_order_id = ?',
      [req.params.id]
    );
    if (!att.n) {
      await conn.rollback();
      return res.status(409).json({
        error: 'Attach the perspective and Bill of Materials before requesting Sales Approval.',
        reason: 'no_attachment',
      });
    }
    // CLOSE THE LAYOUT TIMER IF IT IS STILL OPEN, because handing work to Sales is finishing it.
    //
    // layout_ended_at is what the Artist Incentive report requires and dates by, and nothing was
    // setting it on this path. Only the "Done" button closed the timer, and that button needs the
    // artist to have pressed Play first -- so an artist who submitted without running the timer
    // reached "Approved" with layout_ended_at still NULL and earned nothing. All three approved
    // Job Orders in this database are in exactly that state, which is why the report showed zero.
    //
    // The end is stamped HERE rather than at approval, because the report dates the incentive to
    // when the work was done, not when Sales got round to accepting it -- so an order approved in
    // the following month still lands in the period the artist worked.
    //
    // layout_started_at is deliberately NOT invented. If the artist never started the timer we do
    // not know when they began, and writing started = ended would claim the layout took no time
    // and quietly distort their performance figures. A missing duration is honest; a fabricated
    // one is not.
    if (!jo.layout_ended_at) {
      await conn.query('UPDATE job_order_layout_sessions SET ended_at = NOW() WHERE job_order_id = ? AND ended_at IS NULL', [req.params.id]);
      await conn.query('UPDATE job_orders SET layout_ended_at = NOW() WHERE id = ?', [req.params.id]);
      await logAudit(conn, {
        jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated',
        fieldName: 'layout_ended_at', newValue: 'closed on submission for Sales Approval',
      });
    }
    await conn.query("UPDATE job_orders SET sub_status = 'Sales Approval', updated_at = NOW() WHERE id = ?", [req.params.id]);
    // Tell the sales rep who owns this Job Order. Without it the hand-off was silent: the layout
    // was finished and waiting on them, and the only way to find out was to go looking.
    // Non-Standard Job Orders have notified on this transition all along -- Job Orders did not.
    await notifySalesRep(conn, {
      salesRepEmployeeId: jo.sales_rep_id,
      title: `${jo.job_order_no} is ready for your sign-off`,
      message: 'The artist has finished the layout and sent it for Sales Approval.',
      relatedType: 'JobOrder',
      relatedId: Number(req.params.id),
    });
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
    const [[jo]] = await conn.query(
      'SELECT sub_status, artist_id, job_order_no FROM job_orders WHERE id = ?',
      [req.params.id]
    );
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
    // Tell the artist their work has come back. Without this the sub-status changed and nothing
    // said so -- the artist would find out by noticing the order had reappeared in their queue,
    // which is exactly as reliable as it sounds.
    //
    // Remarks are accepted if sent but not required: the Job Order view has no reason box today,
    // unlike the Non-Standard equivalent. Worth adding, and this will carry it the moment it
    // exists rather than needing a second change here.
    const remarks = String(req.body?.remarks || '').trim();
    await notifyAssignedArtist(conn, {
      artistEmployeeId: jo.artist_id,
      type: NOTIFY_TYPE_JO_REVISION,
      title: `${jo.job_order_no} has been sent back for revision`,
      message: remarks
        ? `Sales asked for changes: ${remarks.slice(0, 300)}`
        : 'Sales returned this layout for revision. Check with them for what needs changing.',
      relatedType: 'JobOrder',
      relatedId: Number(req.params.id),
    });
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

router.post('/:id/processes', requireAuth, requireJobOrderEdit, async (req, res, next) => {
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

router.put('/:id/processes/:procId', requireAuth, requireJobOrderEdit, async (req, res, next) => {
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

router.delete('/:id/processes/:procId', requireAuth, requireJobOrderEdit, async (req, res, next) => {
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

// ---------------------------------------------------------------------------------------
// Artist Attachments -- the artist's perspective drawing and Cutting List / Bill of Materials
// ---------------------------------------------------------------------------------------
//
// Any file type is accepted. Uploads are base64 in a JSON body (see the scoped body parser
// in index.js). The size cap is deliberate: these rows live in the database, so an unbounded
// upload grows the same volume that everything else writes to.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_KINDS = ['Perspective', 'Bill of Materials', 'Other'];

// Uploading is the assigned artist's job; anyone with can_edit on Job Orders (design
// supervisors, admins) can also attach on their behalf. Removal is stricter -- see the
// DELETE handler.
async function canManageAttachments(conn, userId, jobOrderId) {
  const [[jo]] = await conn.query('SELECT artist_id FROM job_orders WHERE id = ?', [jobOrderId]);
  if (!jo) return { ok: false, missing: true };
  const [[me]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [userId]);
  if (me?.employee_id && jo.artist_id === me.employee_id) return { ok: true };
  const [[page]] = await conn.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  const [[perm]] = await conn.query(
    'SELECT can_edit AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?',
    [userId, page?.id]
  );
  return { ok: !!perm?.allowed };
}

// Metadata only -- the blob would make the JO view's payload enormous for no benefit.
router.get('/:id/attachments', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.id, a.kind, a.file_name, a.mime_type, a.size_bytes, a.created_at,
              u.display_name AS uploaded_by_name
         FROM job_order_attachments a
         LEFT JOIN users u ON u.id = a.uploaded_by_user_id
        WHERE a.job_order_id = ?
        ORDER BY a.created_at DESC, a.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/attachments', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const access = await canManageAttachments(conn, req.user.id, req.params.id);
    if (access.missing) return res.status(404).json({ error: 'Not found' });
    if (!access.ok) return res.status(403).json({ error: 'Only the assigned artist can attach files to this Job Order' });

    const { file_name: fileName, kind, data, mime_type: mimeType } = req.body || {};
    if (!fileName || !data) return res.status(400).json({ error: 'file_name and data are required' });
    if (!ATTACHMENT_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${ATTACHMENT_KINDS.join(', ')}` });
    }

    // Accepts either a bare base64 string or a full data: URL, since the browser's FileReader
    // hands back the latter.
    const base64 = String(data).includes(',') ? String(data).split(',').pop() : String(data);
    let buf;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'data is not valid base64' });
    }
    if (!buf.length) return res.status(400).json({ error: 'The uploaded file is empty' });
    if (buf.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `Files must be ${MAX_UPLOAD_BYTES / 1024 / 1024}MB or smaller` });
    }

    // Any file type is accepted -- artists attach drawings, spreadsheets and images as well
    // as PDFs. The browser's reported type is stored only to serve the download back with a
    // sensible Content-Type; it is never trusted to decide anything.
    const safeMime = /^[\w.+-]+\/[\w.+-]+$/.test(String(mimeType || ''))
      ? String(mimeType).slice(0, 100)
      : 'application/octet-stream';

    const [result] = await conn.query(
      `INSERT INTO job_order_attachments (job_order_id, kind, file_name, mime_type, size_bytes, file_data, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, kind, String(fileName).slice(0, 255), safeMime, buf.length, buf, req.user.id]
    );
    const [[row]] = await conn.query(
      `SELECT id, kind, file_name, mime_type, size_bytes, created_at FROM job_order_attachments WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json(row);
  } catch (err) {
    next(err);
  } finally {
    conn.release();
  }
});

router.get('/:id/attachments/:attachmentId/file', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      'SELECT file_name, mime_type, file_data FROM job_order_attachments WHERE id = ? AND job_order_id = ?',
      [req.params.attachmentId, req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    // PDFs and images open in a tab; anything else the browser cannot render is offered as a
    // download rather than dumped as text.
    const inline = /^(application\/pdf|image\/)/.test(row.mime_type || '');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${row.file_name.replace(/"/g, '')}"`
    );
    res.send(row.file_data);
  } catch (err) {
    next(err);
  }
});

// Removal is System Admin only -- deliberately narrower than upload. An attachment is what
// Sales approved against, so an artist replacing or deleting one after the fact would change
// the record behind the approval. Artists add; only an admin takes away.
router.delete('/:id/attachments/:attachmentId', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    if (!(await isSystemAdmin(req.user.id))) {
      return res.status(403).json({ error: 'Only a System Admin can remove an attachment' });
    }

    const [r] = await conn.query(
      'DELETE FROM job_order_attachments WHERE id = ? AND job_order_id = ?',
      [req.params.attachmentId, req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------------------------------
// Printable Job Order (the production sheet: header + jobs + specifications + logistics slip)
// ---------------------------------------------------------------------------------------
//
// Who may print:
//   System Admin  -- any JO, at any status, assigned or not.
//   Everyone else -- needs can_print on /job-orders AND a JO that has an artist assigned.
//
// The artist rule is the point of the gate: an unassigned JO has not been through design, so
// its sheet would send work to the floor that nobody has been made responsible for. Admins
// are exempt because they need to be able to reprint anything, including historical JOs from
// before assignment was tracked.
router.get('/:id/print', requireAuth, async (req, res, next) => {
  try {
    const [[jo]] = await pool.query(
      `SELECT jo.*, so.sales_order_no, so.contract_description, so.credit_term, so.date_created AS so_date,
              so.shipping_address AS so_shipping_address, so.memo AS so_memo,
              c.name AS customer_name,
              jt.display_name AS job_type_name,
              sd.name AS sales_division_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name,
              cc.contact_name
         FROM job_orders jo
         JOIN sales_orders so ON so.id = jo.sales_order_id
         LEFT JOIN customers c ON c.id = so.customer_id
         LEFT JOIN job_types jt ON jt.id = jo.job_type_id
         LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
         LEFT JOIN employees sr ON sr.id = so.sales_rep_id
         LEFT JOIN employees ar ON ar.id = jo.artist_id
         LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
        WHERE jo.id = ?`,
      [req.params.id]
    );
    if (!jo) return res.status(404).json({ error: 'Not found' });

    if (!(await isSystemAdmin(req.user.id))) {
      const [[page]] = await pool.query("SELECT id FROM pages WHERE route = ?", [ROUTE]);
      if (!page) return res.status(500).json({ error: `Page not registered: ${ROUTE}` });
      const [[perm]] = await pool.query(
        'SELECT can_print FROM user_page_permissions WHERE user_id = ? AND page_id = ?',
        [req.user.id, page.id]
      );
      if (!perm || !perm.can_print) {
        return res.status(403).json({ error: 'You do not have permission to print a Job Order' });
      }
      // Reported separately from the permission failure: "ask your admin for access" and
      // "assign an artist first" are different problems with different fixes.
      if (!jo.artist_id) {
        return res.status(403).json({
          error: 'This Job Order has no artist assigned yet, so it cannot be printed.',
          reason: 'no_artist',
        });
      }
    }

    const [processes] = await pool.query(
      `SELECT jop.line_no, jop.qty, jop.length, jop.width, jop.uom, jop.unit,
              jop.remarks, jop.memo, jop.artist_remarks,
              pr.process_name,
              i.display_name AS item_name
         FROM job_order_processes jop
         LEFT JOIN processes pr ON pr.id = jop.process_id
         LEFT JOIN inventories i ON i.id = jop.item_id
        WHERE jop.job_order_id = ?
        ORDER BY jop.line_no, jop.id`,
      [req.params.id]
    );

    res.json({ ...jo, processes });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
