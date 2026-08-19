const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { isScopedToDesignQueue, DESIGN_QUEUE_STATUS, DESIGN_QUEUE_SUB_STATUSES } = require('../lib/designSupervisorVisibility');
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');
const { getArtistEmployeeScope } = require('../lib/artistVisibility');
const { notifyDesignSupervisors, notifyAssignedArtist } = require('../lib/designNotifications');
const { getSbuScope, departmentIdsForTab, sbuCanApproveDepartment } = require('../lib/sbuGroups');

const router = express.Router();
const ROUTE = '/non-standard-job-orders';

// The four non-standard job types are master data (job_types.jo_type = 'Non Standard JO'),
// not a hardcoded list -- the live site drives its Job Type lookup off the same master.
const NSTDJO_JO_TYPE = 'Non Standard JO';
// Only SITE INSPECTION changes the form: the PMS Job Type field is relabelled
// "Site Inspection - Job Type" and Optional Address becomes "Site Address".
const SITE_INSPECTION = 'SITE INSPECTION';
// Matches the live site: a freshly saved NSTDJO is queued for its bill of materials.
// Status stays put for the whole design stage -- it is sub_status that advances, exactly
// as it does for Job Orders, which is what lets both share the Design Supervisor queue.
const INITIAL_STATUS = DESIGN_QUEUE_STATUS;
const SUB_PENDING = 'Pending';
// A saved order waits here for its raiser's department approver(s). Deliberately NOT in
// DESIGN_QUEUE_SUB_STATUSES, so an unapproved order never reaches a Design Supervisor.
const SUB_SBU_APPROVAL = 'SBU Approval';
// Bounced back by an approver for changes. Sales can edit the order freely here; saving
// those edits sends it back round to SBU Approval.
const SUB_SALES_REVISION = 'Sales Revision';
// The Design Supervisor's own bounce-back, from their queue rather than from the SBU gate.
// Deliberately a DIFFERENT sub-status from the approver's "Sales Revision", for the same
// reason "For Artist (Revision)" is distinct from "For Artist": Sales and the approvers
// should see at a glance that Design sent this one back, not an approver. It behaves
// identically otherwise -- editable by Sales, and out of every queue until re-approved.
const SUB_SALES_REVISION_DESIGN = 'Sales Revision (Design)';
// Cleared by an approver but not yet handed over. Approval only unlocks the handoff --
// Sales still chooses when the order actually goes to Design by pressing Forward, which
// is what moves it to "For Design Supervisor". Deliberately NOT in
// DESIGN_QUEUE_SUB_STATUSES, so an approved-but-unforwarded order stays out of Design's view.
const SUB_SBU_APPROVED = 'SBU Approved';
const SUB_FOR_DESIGN = 'For Design Supervisor';
const SUB_FOR_ARTIST = 'For Artist';
// Sent back by Sales from the sign-off queue. Deliberately a DIFFERENT sub-status from the
// ordinary "For Artist" so the artist's worklist shows at a glance that this one is rework.
// Same wording Job Orders already use for the same moment, so both halves of the workflow
// read identically to an artist who runs both.
const SUB_FOR_ARTIST_REVISION = 'For Artist (Revision)';
// The states in which the order is in the artist's hands. Everything that used to test for
// "For Artist" alone has to test this instead -- an order that vanishes from the artist's
// queue the moment it is sent back for revision is worse than having no revision at all.
const ARTIST_WORKING_SUB_STATUSES = [SUB_FOR_ARTIST, SUB_FOR_ARTIST_REVISION];
// Three per order, then the button stops. Without a ceiling, "send it back" becomes a
// substitute for deciding what is wanted, and the artist absorbs the cost of every lap.
// The counter is per order and never resets.
const MAX_SALES_REVISIONS = 3;
// The window in which Sales may still change an order: while it is queued for its
// approver(s), and while an approver has parked it back with them for changes. Approval
// closes the window -- from "SBU Approved" onward the details an approver signed off
// against must not shift underneath the order.
const EDITABLE_SUB_STATUSES = [SUB_SBU_APPROVAL, SUB_SALES_REVISION, SUB_SALES_REVISION_DESIGN];
// The artist sends their finished layout to Sales, who sign it off. Where a Job Order
// would go to "Released" and on into production, a Non-Standard Job Order has nothing
// downstream of the layout -- so Sales sign-off is the end of its life: COMPLETED.
const SUB_SALES_APPROVAL = 'Sales Approval';
const SUB_APPROVED = 'Approved';
const COMPLETED_STATUS = 'COMPLETED';
// The states Forward can act from: approved, or never gated because the raiser's
// department has no approvers configured.
const FORWARDABLE_SUB_STATUSES = [SUB_PENDING, SUB_SBU_APPROVED];
const CANCELLED_STATUS = 'Cancelled';
// End states -- nothing further can be done to an order once it reaches one of these.
const TERMINAL_STATUSES = [CANCELLED_STATUS, COMPLETED_STATUS];
// The artist earns 5% of a materials line's Process Price.
const ARTIST_INCENTIVE_RATE = 0.05;

// Feeds the detail view's System Info tab, same shape every other module logs.
async function logAudit(conn, { id, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('NonStandardJobOrder', ?, ?, ?, ?, ?, ?)`,
    [id, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId],
  );
}

async function defaultBranch(userId) {
  const [[branch]] = await pool.query(
    `SELECT u.employee_id, ub.location_id, ub.department_id AS sales_division_id
       FROM users u
       LEFT JOIN user_branches ub ON ub.user_id = u.id AND ub.is_default = TRUE
      WHERE u.id = ?`,
    [userId],
  );
  return branch || {};
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [customers, employees, locations, divisions, jobTypes, pmsJobTypes, processes, items, uoms, defaults] = await Promise.all([
      pool.query('SELECT id, name FROM customers WHERE is_active = TRUE ORDER BY name'),
      pool.query('SELECT id, first_name, last_name FROM employees WHERE is_active = TRUE ORDER BY first_name, last_name'),
      pool.query('SELECT id, location_name FROM locations WHERE is_active = TRUE ORDER BY location_name'),
      pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name'),
      pool.query('SELECT id, display_name, base_unit FROM job_types WHERE jo_type = ? AND is_active = TRUE ORDER BY display_name', [NSTDJO_JO_TYPE]),
      // job_type_id is what makes the PMS lookup cascade -- the client narrows this
      // list to the chosen Job Type, exactly as the live site does.
      pool.query('SELECT id, code, display_name, minutes_consume, job_type_id FROM pms_job_types ORDER BY display_name'),
      pool.query('SELECT id, process_code, process_name FROM processes WHERE is_active = TRUE ORDER BY process_name'),
      pool.query('SELECT id, item_code, display_name FROM inventories WHERE is_active = TRUE ORDER BY display_name'),
      pool.query('SELECT id, code, title FROM units_of_measure WHERE is_active = TRUE ORDER BY code'),
      defaultBranch(req.user.id),
    ]);
    const sbuScope = await getSbuScope(req.user.id);
    res.json({
      customers: customers[0], employees: employees[0], locations: locations[0], divisions: divisions[0],
      jobTypes: jobTypes[0], pmsJobTypes: pmsJobTypes[0], processes: processes[0], items: items[0], uoms: uoms[0],
      siteInspection: SITE_INSPECTION, defaults,
      // Present only for an SBU -- the SBU 1 / SBU 2 tabs are theirs alone, since nobody
      // else's visibility spans both groups.
      sbuGroups: sbuScope ? sbuScope.groups.map((g) => ({ index: g.index, label: g.label, name: g.displayName })) : [],
    });
  } catch (err) { next(err); }
});

// Contact Person cascades off Customer -- the field stays disabled until a customer is
// picked, and choosing a contact auto-fills the email/title/phone below it.
router.get('/contacts', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { customer_id: customerId } = req.query;
    if (!customerId) return res.json({ contacts: [] });
    const [contacts] = await pool.query(
      'SELECT id, contact_name, title, email, phone, description FROM customer_contacts WHERE customer_id = ? ORDER BY is_primary DESC, contact_name',
      [customerId],
    );
    res.json({ contacts });
  } catch (err) { next(err); }
});

// Add a contact person without leaving the NSTDJO form. Writes to customer_contacts, the
// same table Master Lists > Customer reads, so a contact added here is immediately part of
// that customer's details rather than a copy local to this order.
//
// Exposed under this page's own can_add rather than reusing POST /customers/:id/contacts,
// which requires Customers can_edit -- the same reasoning as the cost-brackets route below:
// raising a job order should not require rights to edit the customer master.
router.post('/contacts', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const { customer_id: customerId, contact_name: contactName, title, email, phone } = req.body;
    if (!customerId) return res.status(400).json({ error: 'Select a customer first.' });
    if (!contactName || !contactName.trim()) return res.status(400).json({ error: 'Contact name is required.' });

    const [[customer]] = await pool.query('SELECT id FROM customers WHERE id = ?', [customerId]);
    if (!customer) return res.status(400).json({ error: 'Invalid customer.' });

    const [result] = await pool.query(
      `INSERT INTO customer_contacts (customer_id, contact_name, title, email, phone, is_primary)
       VALUES (?, ?, ?, ?, ?, FALSE)`,
      [customerId, contactName.trim(), title?.trim() || null, email?.trim() || null, phone?.trim() || null],
    );
    const [[row]] = await pool.query(
      'SELECT id, contact_name, title, email, phone, description FROM customer_contacts WHERE id = ?',
      [result.insertId],
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// Process Price on a materials line is derived from Process Costing, so the grid needs a
// process's quantity brackets. Exposed here under this page's own permission rather than
// reusing /process-costing/:id/cost-brackets, which would force everyone raising an
// NSTDJO to also hold Process Costing view rights. Registered before '/:id' so the
// literal path is not swallowed by that parameter.
router.get('/cost-brackets/:processId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM process_cost_brackets WHERE process_id = ? AND is_active = TRUE ORDER BY qty_min',
      [req.params.processId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search = '', page = 1, limit = 10 } = req.query;
    const params = [];
    const conditions = [];
    if (search) {
      conditions.push('(n.nstdjo_no LIKE ? OR n.description LIKE ? OR c.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    // A Design Supervisor only sees their own design queue -- orders awaiting an artist
    // from them ("For Design Supervisor") or already handed to one ("For Artist") -- not
    // every non-standard job order. Same rule Job Orders apply. That queue IS their whole
    // view of this module, so it replaces the sales-rep scope rather than stacking with
    // it; otherwise a supervisor who is also an account officer would see neither set.
    const sbuScope = await getSbuScope(req.user.id);
    if (await isScopedToDesignQueue(req.user.id)) {
      conditions.push('n.status = ? AND n.sub_status IN (?)');
      params.push(DESIGN_QUEUE_STATUS, DESIGN_QUEUE_SUB_STATUSES);
    } else if (sbuScope) {
      // An SBU sees BOTH SBU groups' orders, not just the divisions they own -- they
      // approve each other's groups, and an approver who cannot find an order cannot
      // approve it. The SBU 1 / SBU 2 tabs narrow this to one group; no tab means both.
      // This replaces the sales-rep scope rather than stacking with it, the same way the
      // design queue does above -- an SBU is also a supervisor, and intersecting the two
      // would hand them back only their own reports.
      conditions.push('n.sales_division_id IN (?)');
      params.push(departmentIdsForTab(sbuScope, req.query.sbu));
    } else {
      // Otherwise a user sees their own orders; a Supervisor also sees their direct
      // reports'. Shared with Estimates/Sales Orders so "my transactions" means the same
      // thing across Sales.
      const scope = await getSalesRepEmployeeScope(req.user.id);
      const artistEmployeeId = await getArtistEmployeeScope(req.user.id);
      if (scope) {
        conditions.push('n.sales_rep_id IN (?)');
        params.push(scope);
      } else if (artistEmployeeId) {
        // An Artist sees only what is assigned to them -- they would otherwise fall
        // through every filter above and see the whole module.
        conditions.push('n.artist_employee_id = ?');
        params.push(artistEmployeeId);
      }
    }
    // For Approval / Approved tab. "Approved" is keyed on approved_at rather than the
    // "SBU Approved" sub-status: an approved order moves on through Design and production,
    // so a sub-status test would empty the tab as soon as the work actually progressed,
    // which reads as the approval having been lost.
    const APPROVAL_FILTERS = {
      for_approval: { sql: 'n.sub_status = ?', params: [SUB_SBU_APPROVAL] },
      approved: { sql: 'n.approved_at IS NOT NULL', params: [] },
    };
    const approvalFilter = APPROVAL_FILTERS[req.query.approval];
    // Counts are taken BEFORE this filter is applied, so each tab shows its own total
    // rather than the count of whichever tab happens to be open.
    const countWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countParams = [...params];
    if (approvalFilter) {
      conditions.push(approvalFilter.sql);
      params.push(...approvalFilter.params);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const from = `FROM non_standard_job_orders n
      JOIN customers c ON c.id = n.customer_id
      LEFT JOIN customer_contacts cc ON cc.id = n.contact_person_id
      LEFT JOIN employees e ON e.id = n.sales_rep_id
      LEFT JOIN employees ar ON ar.id = n.artist_employee_id
      LEFT JOIN departments d ON d.id = n.sales_division_id
      LEFT JOIN pms_job_types pjt ON pjt.id = n.pms_job_type_id`;
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) total ${from} ${where}`, params);
    const size = Math.min(100, Math.max(1, Number(limit)));
    const current = Math.max(1, Number(page));
    const [rows] = await pool.query(
      `SELECT n.*, c.name customer_name, d.name sales_division_name,
              cc.contact_name contact_person_name,
              CONCAT(e.first_name, ' ', e.last_name) sales_rep_name,
              CONCAT(ar.first_name, ' ', ar.last_name) artist_name,
              EXISTS(SELECT 1 FROM non_standard_job_order_approvers na
                      WHERE na.non_standard_job_order_id = n.id AND na.user_id = ?) AS is_my_approval,
              pjt.code pms_job_type_code, pjt.display_name pms_job_type_name
         ${from} ${where} ORDER BY n.id DESC LIMIT ? OFFSET ?`,
      [req.user.id, ...params, size, (current - 1) * size],
    );
    // is_my_approval stays literally "am I tagged on this one" -- it is what puts "(yours)"
    // on the row. can_approve is the question the tick box actually asks, and for an SBU
    // that includes the other group's orders even though they are tagged on neither.
    for (const row of rows) {
      row.can_approve = !!row.is_my_approval
        || (!!sbuScope && sbuScope.departmentIds.includes(Number(row.sales_division_id)));
    }
    const [[counts]] = await pool.query(
      `SELECT COUNT(*) AS all_count,
              SUM(n.sub_status = ?) AS for_approval,
              SUM(n.approved_at IS NOT NULL) AS approved
         ${from} ${countWhere}`,
      [SUB_SBU_APPROVAL, ...countParams],
    );
    res.json({
      rows, total, page: current, limit: size,
      counts: {
        all: Number(counts.all_count) || 0,
        for_approval: Number(counts.for_approval) || 0,
        approved: Number(counts.approved) || 0,
      },
    });
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT n.*, c.name customer_name, cc.contact_name contact_person_name, d.name sales_division_name,
              CONCAT(e.first_name, ' ', e.last_name) sales_rep_name, l.location_name job_location_name,
              CONCAT(ar.first_name, ' ', ar.last_name) artist_name,
              u.display_name created_by_name, ab.display_name approved_by_name,
              (SELECT GROUP_CONCAT(au.display_name SEPARATOR ', ')
                 FROM non_standard_job_order_approvers na JOIN users au ON au.id = na.user_id
                WHERE na.non_standard_job_order_id = n.id) AS approver_names,
              EXISTS(SELECT 1 FROM non_standard_job_order_approvers na
                      WHERE na.non_standard_job_order_id = n.id AND na.user_id = ?) AS is_my_approval,
              (n.created_by_user_id = ?) AS is_mine,
              (n.artist_employee_id IS NOT NULL
               AND n.artist_employee_id = (SELECT employee_id FROM users WHERE id = ?)) AS is_my_assignment,
              pjt.code pms_job_type_code, pjt.display_name pms_job_type_name, pjt.minutes_consume pms_job_type_minutes,
              ljt.code layout_job_type_code, ljt.display_name layout_job_type_name, ljt.minutes_consume layout_job_type_minutes
         FROM non_standard_job_orders n
         JOIN customers c ON c.id = n.customer_id
         LEFT JOIN customer_contacts cc ON cc.id = n.contact_person_id
         LEFT JOIN employees e ON e.id = n.sales_rep_id
         LEFT JOIN employees ar ON ar.id = n.artist_employee_id
         LEFT JOIN users u ON u.id = n.created_by_user_id
         LEFT JOIN users ab ON ab.id = n.approved_by_user_id
         LEFT JOIN departments d ON d.id = n.sales_division_id
         LEFT JOIN locations l ON l.id = n.job_location_id
         LEFT JOIN pms_job_types pjt ON pjt.id = n.pms_job_type_id
         LEFT JOIN pms_job_types ljt ON ljt.id = n.layout_job_type_id
        WHERE n.id = ?`,
      [req.user.id, req.user.id, req.user.id, req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Non-standard job order not found.' });
    // Defense in depth -- neither a Design Supervisor nor a sales user can open an order
    // outside their scope by pasting its URL, even though the list already filters it out.
    if (await isScopedToDesignQueue(req.user.id)) {
      if (row.status !== DESIGN_QUEUE_STATUS || !DESIGN_QUEUE_SUB_STATUSES.includes(row.sub_status)) {
        return res.status(404).json({ error: 'Non-standard job order not found.' });
      }
    } else {
      const scope = await getSalesRepEmployeeScope(req.user.id);
      const artistEmployeeId = await getArtistEmployeeScope(req.user.id);
      if (scope && !scope.map(String).includes(String(row.sales_rep_id))) {
        return res.status(404).json({ error: 'Non-standard job order not found.' });
      }
      if (!scope && artistEmployeeId && String(row.artist_employee_id) !== String(artistEmployeeId)) {
        return res.status(404).json({ error: 'Non-standard job order not found.' });
      }
    }
    const [materials] = await pool.query(
      `SELECT m.*, p.process_name, i.display_name item_name, i.item_code
         FROM non_standard_job_order_materials m
         LEFT JOIN processes p ON p.id = m.process_id
         LEFT JOIN inventories i ON i.id = m.item_id
        WHERE m.non_standard_job_order_id = ? ORDER BY m.line_no`,
      [req.params.id],
    );
    res.json({ ...row, materials });
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const h = req.body || {};
    const branch = await defaultBranch(req.user.id);
    const jobLocationId = branch.location_id || h.job_location_id;
    if (!h.customer_id || !jobLocationId || !h.description?.trim() || !h.quantity || Number(h.quantity) <= 0 || !h.delivery_date) {
      return res.status(400).json({ error: 'Customer, job location, description, positive quantity, and delivery date are required.' });
    }

    const [[jobType]] = await conn.query(
      'SELECT id, display_name FROM job_types WHERE id = ? AND jo_type = ? AND is_active = TRUE',
      [h.job_type_id, NSTDJO_JO_TYPE],
    );
    if (!jobType) return res.status(400).json({ error: 'Choose a valid non-standard job type.' });

    if (!h.contact_person_id) return res.status(400).json({ error: 'Contact person is required.' });
    const [[contact]] = await conn.query(
      'SELECT id, contact_name, title, email, phone FROM customer_contacts WHERE id = ? AND customer_id = ?',
      [h.contact_person_id, h.customer_id],
    );
    if (!contact) return res.status(400).json({ error: 'The selected contact person does not belong to this customer.' });

    if (h.pms_job_type_id) {
      // The PMS Job Type list is scoped to the chosen Job Type, so a mismatched pair is
      // only reachable by tampering -- reject rather than silently clearing it.
      const [[pmsJobType]] = await conn.query('SELECT id, job_type_id FROM pms_job_types WHERE id = ?', [h.pms_job_type_id]);
      if (!pmsJobType) return res.status(400).json({ error: 'The selected PMS Job Type no longer exists.' });
      if (String(pmsJobType.job_type_id) !== String(jobType.id)) {
        return res.status(400).json({ error: 'That PMS Job Type does not belong to the selected job type.' });
      }
    }
    if (!branch.employee_id) return res.status(400).json({ error: 'Your user account needs an assigned employee before a non-standard job order can be saved.' });
    if (!branch.sales_division_id) return res.status(400).json({ error: 'Your default User Branch needs a department before a non-standard job order can be saved.' });

    const materials = Array.isArray(h.materials) ? h.materials.filter((m) => m && (m.process_id || m.item_id || m.qty || m.process_qty)) : [];

    // Who signs off on this order -- the raiser's own department approvers, exactly as
    // Tickets derive them. A department with none configured has no gate to clear, so the
    // order skips straight past SBU Approval rather than stalling in a queue that has
    // nobody in it.
    const [approvers] = await conn.query(
      `SELECT dta.user_id FROM users u
         JOIN employees e ON e.id = u.employee_id
         JOIN departments d ON d.id = e.department_id
         JOIN department_ticket_approvers dta ON dta.department_id = d.id
        WHERE u.id = ?`,
      [req.user.id],
    );
    const needsApproval = approvers.length > 0;
    const initialSubStatus = needsApproval ? SUB_SBU_APPROVAL : SUB_PENDING;

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO non_standard_job_orders
       (nstdjo_no, customer_id, contact_person_id, contact_email, contact_title, contact_phone, memo, date_created,
        job_location_id, job_type_id, job_type, pms_job_type_id, description, quantity,
        shipping_address, delivery_date, delivery_time, sales_rep_id, sales_division_id,
        status, sub_status, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['PENDING', h.customer_id, contact.id, h.contact_email ?? contact.email, h.contact_title ?? contact.title,
        h.contact_phone ?? contact.phone, h.memo || null,
        h.date_created || new Date().toISOString().slice(0, 10), jobLocationId, jobType.id, jobType.display_name,
        h.pms_job_type_id || null, h.description.trim(), h.quantity, h.shipping_address || null,
        h.delivery_date, h.delivery_time || null, branch.employee_id, branch.sales_division_id,
        INITIAL_STATUS, initialSubStatus, req.user.id],
    );
    const nstdjoNo = `NSTDJO-${result.insertId}`;
    await conn.query('UPDATE non_standard_job_orders SET nstdjo_no = ? WHERE id = ?', [nstdjoNo, result.insertId]);

    for (const [index, m] of materials.entries()) {
      // Recomputed here rather than trusting the client's figure -- this drives a payout.
      const artistIncentive = m.process_price ? Number((Number(m.process_price) * ARTIST_INCENTIVE_RATE).toFixed(2)) : null;
      await conn.query(
        `INSERT INTO non_standard_job_order_materials
         (non_standard_job_order_id, line_no, process_id, process_qty, process_price, artist_incentive,
          item_id, artist_remarks, length, width, uom, qty, total, unit, sales_remarks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [result.insertId, index + 1, m.process_id || null, m.process_qty || null, m.process_price || null,
          artistIncentive, m.item_id || null, m.artist_remarks || null, m.length || null, m.width || null,
          m.uom || null, m.qty || null, m.total || null, m.unit || null, m.sales_remarks || null],
      );
    }

    for (const { user_id: approverUserId } of approvers) {
      await conn.query(
        'INSERT INTO non_standard_job_order_approvers (non_standard_job_order_id, user_id) VALUES (?, ?)',
        [result.insertId, approverUserId],
      );
      await conn.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, 'nstdjo_pending_approval', ?, ?, 'NonStandardJobOrder', ?)`,
        [approverUserId, `${nstdjoNo} needs your approval`, h.description.trim().slice(0, 500), result.insertId],
      );
    }

    await logAudit(conn, { id: result.insertId, userId: req.user.id, eventType: 'Created' });

    await conn.commit();
    res.status(201).json({
      id: result.insertId, nstdjo_no: nstdjoNo, status: INITIAL_STATUS,
      sub_status: initialSubStatus, needs_approval: needsApproval,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// "Forward To Design Supervisor" on the live site -- a second submit action beside Save
// that hands the saved order to Design. Recorded via forwarded_at so it only happens once.
router.post('/:id/forward', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[row]] = await conn.query(
      'SELECT id, nstdjo_no, description, status, sub_status, forwarded_at FROM non_standard_job_orders WHERE id = ?',
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Non-standard job order not found.' });
    if (TERMINAL_STATUSES.includes(row.status)) {
      return res.status(409).json({ error: `This job order is ${row.status} and can no longer be forwarded.` });
    }
    // Nothing reaches Design until the SBU gate is cleared -- neither while it is still
    // waiting on an approver, nor while it is parked with Sales for changes.
    if (row.sub_status === SUB_SBU_APPROVAL) {
      return res.status(409).json({ error: 'This job order is still pending SBU approval.' });
    }
    if (row.sub_status === SUB_SALES_REVISION || row.sub_status === SUB_SALES_REVISION_DESIGN) {
      return res.status(409).json({ error: 'This job order was sent back for revision and must be re-approved first.' });
    }
    // Checked before the general state guard below so a second Forward gets the specific
    // "already forwarded" message rather than a vaguer one about its current sub status.
    if (row.forwarded_at) return res.status(400).json({ error: 'This job order has already been forwarded to the design supervisor.' });
    if (!FORWARDABLE_SUB_STATUSES.includes(row.sub_status)) {
      return res.status(409).json({ error: `This job order is ${row.sub_status} and cannot be forwarded.` });
    }
    await conn.beginTransaction();
    // Status is deliberately untouched -- moving sub_status is what puts this in the
    // Design Supervisor's queue; overwriting status would drop it out of that filter.
    await conn.query(
      'UPDATE non_standard_job_orders SET forwarded_at = NOW(), sub_status = ?, updated_at = NOW() WHERE id = ?',
      [SUB_FOR_DESIGN, req.params.id],
    );
    await logAudit(conn, {
      id: req.params.id, userId: req.user.id, eventType: 'Status Change',
      fieldName: 'sub_status', oldValue: row.sub_status, newValue: SUB_FOR_DESIGN,
    });
    // The order has just landed in the design queue with no artist on it -- tell the
    // supervisors it is waiting rather than relying on someone refreshing the list.
    await notifyDesignSupervisors(conn, {
      title: `${row.nstdjo_no} needs an artist assigned`,
      message: row.description ? String(row.description).slice(0, 500) : null,
      relatedType: 'NonStandardJobOrder',
      relatedId: req.params.id,
      excludeUserId: req.user.id,
    });
    await conn.commit();
    res.json({ id: Number(req.params.id), status: row.status, sub_status: SUB_FOR_DESIGN });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

router.post('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[row]] = await conn.query('SELECT id, status FROM non_standard_job_orders WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Non-standard job order not found.' });
    if (row.status === CANCELLED_STATUS) return res.status(400).json({ error: 'This job order is already cancelled.' });
    // A completed order is finished business -- cancelling it would rewrite history.
    if (row.status === COMPLETED_STATUS) return res.status(409).json({ error: 'This job order is completed and can no longer be cancelled.' });
    await conn.beginTransaction();
    await conn.query(
      'UPDATE non_standard_job_orders SET status = ?, updated_at = NOW() WHERE id = ?',
      [CANCELLED_STATUS, req.params.id],
    );
    await logAudit(conn, {
      id: req.params.id, userId: req.user.id, eventType: 'Cancelled',
      fieldName: 'status', oldValue: row.status, newValue: CANCELLED_STATUS,
    });
    await conn.commit();
    res.json({ id: Number(req.params.id), status: CANCELLED_STATUS });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// Sales changes an order that has not cleared the SBU gate yet -- either still queued for
// its approver(s), or bounced back to them for rework. Deliberately closed once approved:
// from there the order is on its way to Design and the details it was approved against
// must not shift underneath. Saving always (re)parks the order on SBU Approval and clears
// any recorded approval, so an approver signs off on what actually changed rather than on
// a version that has since been edited out from under them.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const h = req.body || {};
    const [[row]] = await conn.query(
      'SELECT id, nstdjo_no, status, sub_status, customer_id, created_by_user_id FROM non_standard_job_orders WHERE id = ?',
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Non-standard job order not found.' });
    if (row.status === CANCELLED_STATUS) return res.status(409).json({ error: 'This job order has been cancelled.' });
    if (!EDITABLE_SUB_STATUSES.includes(row.sub_status)) {
      return res.status(409).json({ error: `This job order is ${row.sub_status} and can no longer be edited.` });
    }
    // Only the person who raised it may change it. A supervisor can see a subordinate's
    // order but not edit it; System Admin keeps its usual override.
    const [[me]] = await conn.query('SELECT account_type FROM users WHERE id = ?', [req.user.id]);
    if (String(row.created_by_user_id) !== String(req.user.id) && me?.account_type !== 'System Admin') {
      return res.status(403).json({ error: 'Only the user who raised this job order can edit it.' });
    }
    if (!h.customer_id || !h.description?.trim() || !h.quantity || Number(h.quantity) <= 0 || !h.delivery_date) {
      return res.status(400).json({ error: 'Customer, description, positive quantity, and delivery date are required.' });
    }

    const [[jobType]] = await conn.query(
      'SELECT id, display_name FROM job_types WHERE id = ? AND jo_type = ? AND is_active = TRUE',
      [h.job_type_id, NSTDJO_JO_TYPE],
    );
    if (!jobType) return res.status(400).json({ error: 'Choose a valid non-standard job type.' });

    if (!h.contact_person_id) return res.status(400).json({ error: 'Contact person is required.' });
    const [[contact]] = await conn.query(
      'SELECT id, contact_name, title, email, phone FROM customer_contacts WHERE id = ? AND customer_id = ?',
      [h.contact_person_id, h.customer_id],
    );
    if (!contact) return res.status(400).json({ error: 'The selected contact person does not belong to this customer.' });

    if (h.pms_job_type_id) {
      const [[pmsJobType]] = await conn.query('SELECT id, job_type_id FROM pms_job_types WHERE id = ?', [h.pms_job_type_id]);
      if (!pmsJobType) return res.status(400).json({ error: 'The selected PMS Job Type no longer exists.' });
      if (String(pmsJobType.job_type_id) !== String(jobType.id)) {
        return res.status(400).json({ error: 'That PMS Job Type does not belong to the selected job type.' });
      }
    }

    const materials = Array.isArray(h.materials) ? h.materials.filter((m) => m && (m.process_id || m.item_id || m.qty || m.process_qty)) : [];

    await conn.beginTransaction();
    await conn.query(
      `UPDATE non_standard_job_orders SET
         customer_id = ?, contact_person_id = ?, contact_email = ?, contact_title = ?, contact_phone = ?,
         memo = ?, date_created = ?, job_type_id = ?, job_type = ?, pms_job_type_id = ?,
         description = ?, quantity = ?, shipping_address = ?, delivery_date = ?, delivery_time = ?,
         sub_status = ?, approved_at = NULL, approved_by_user_id = NULL, updated_at = NOW()
       WHERE id = ?`,
      [h.customer_id, contact.id, h.contact_email ?? contact.email, h.contact_title ?? contact.title,
        h.contact_phone ?? contact.phone, h.memo || null, h.date_created || new Date().toISOString().slice(0, 10),
        jobType.id, jobType.display_name, h.pms_job_type_id || null, h.description.trim(), h.quantity,
        h.shipping_address || null, h.delivery_date, h.delivery_time || null,
        SUB_SBU_APPROVAL, req.params.id],
    );

    // Materials are replaced wholesale rather than diffed -- the grid posts the full set.
    await conn.query('DELETE FROM non_standard_job_order_materials WHERE non_standard_job_order_id = ?', [req.params.id]);
    for (const [index, m] of materials.entries()) {
      const artistIncentive = m.process_price ? Number((Number(m.process_price) * ARTIST_INCENTIVE_RATE).toFixed(2)) : null;
      await conn.query(
        `INSERT INTO non_standard_job_order_materials
         (non_standard_job_order_id, line_no, process_id, process_qty, process_price, artist_incentive,
          item_id, artist_remarks, length, width, uom, qty, total, unit, sales_remarks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.params.id, index + 1, m.process_id || null, m.process_qty || null, m.process_price || null,
          artistIncentive, m.item_id || null, m.artist_remarks || null, m.length || null, m.width || null,
          m.uom || null, m.qty || null, m.total || null, m.unit || null, m.sales_remarks || null],
      );
    }

    await logAudit(conn, { id: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'revised' });
    // Only a real move gets a Status Change entry -- editing an order that is already
    // sitting on SBU Approval leaves it there, and logging "SBU Approval -> SBU Approval"
    // would just be noise in the System Info tab.
    if (row.sub_status !== SUB_SBU_APPROVAL) {
      await logAudit(conn, {
        id: req.params.id, userId: req.user.id, eventType: 'Status Change',
        fieldName: 'sub_status', oldValue: row.sub_status, newValue: SUB_SBU_APPROVAL,
      });
    }

    // Re-notify the approvers on every save, including one that leaves the order sitting
    // where it already was. An approver who has read the order but not yet acted on it
    // would otherwise approve a version that has changed since they looked at it.
    const [approvers] = await conn.query(
      'SELECT user_id FROM non_standard_job_order_approvers WHERE non_standard_job_order_id = ?', [req.params.id],
    );
    for (const { user_id: approverUserId } of approvers) {
      await conn.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, 'nstdjo_pending_approval', ?, ?, 'NonStandardJobOrder', ?)`,
        [approverUserId, `${row.nstdjo_no} was revised and needs your approval`, h.description.trim().slice(0, 500), req.params.id],
      );
    }

    await conn.commit();
    res.json({ id: Number(req.params.id), status: row.status, sub_status: SUB_SBU_APPROVAL });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// SBU approval gate. Any ONE of the order's tagged approvers clears it for everyone --
// not unanimous, same rule as Tickets. Clearing it moves the order out of "SBU Approval"
// and into "For Design Supervisor", which is what makes it visible to Design at all.
router.put('/:id/approve', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[row]] = await conn.query(
      'SELECT id, nstdjo_no, status, sub_status, approved_at, description, created_by_user_id, sales_division_id FROM non_standard_job_orders WHERE id = ?',
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Non-standard job order not found.' });
    if (row.status === CANCELLED_STATUS) return res.status(409).json({ error: 'This job order has been cancelled.' });
    if (row.approved_at) return res.status(409).json({ error: 'This job order has already been approved.' });

    const [[isApprover]] = await conn.query(
      'SELECT 1 AS x FROM non_standard_job_order_approvers WHERE non_standard_job_order_id = ? AND user_id = ?',
      [req.params.id, req.user.id],
    );
    // Either SBU can clear this gate for either group -- see sbuCanApproveDepartment.
    if (!isApprover && !(await sbuCanApproveDepartment(req.user.id, row.sales_division_id))) {
      return res.status(403).json({ error: 'Only this job order\'s designated approver(s) can approve it.' });
    }

    await conn.beginTransaction();
    // Approval clears the gate but does not hand the order over -- it lands on
    // "SBU Approved", where Forward becomes available to Sales.
    await conn.query(
      'UPDATE non_standard_job_orders SET approved_by_user_id = ?, approved_at = NOW(), sub_status = ?, updated_at = NOW() WHERE id = ?',
      [req.user.id, SUB_SBU_APPROVED, req.params.id],
    );
    await conn.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
       VALUES (?, 'nstdjo_approved', ?, ?, 'NonStandardJobOrder', ?)`,
      [row.created_by_user_id, `${row.nstdjo_no} has been approved`,
        `Your non-standard job order ${row.nstdjo_no} is approved and can now be forwarded to the Design Supervisor.`, req.params.id],
    );
    await logAudit(conn, {
      id: req.params.id, userId: req.user.id, eventType: 'Approved',
      fieldName: 'approved_at', newValue: 'approved',
    });
    await logAudit(conn, {
      id: req.params.id, userId: req.user.id, eventType: 'Status Change',
      fieldName: 'sub_status', oldValue: row.sub_status, newValue: SUB_SBU_APPROVED,
    });
    await conn.commit();
    res.json({ id: Number(req.params.id), status: row.status, sub_status: SUB_SBU_APPROVED });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// The artist hands their finished layout to Sales for sign-off. Reachable by the assigned
// artist even without can_edit on this page -- they must be able to submit their own work
// without being granted broader rights over the order -- or by anyone who does hold
// can_edit. Same shape as /job-orders/:id/sales-approval.
router.put('/:id/sales-approval', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[row]] = await conn.query(
      'SELECT id, nstdjo_no, status, sub_status, artist_employee_id, created_by_user_id FROM non_standard_job_orders WHERE id = ?',
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Non-standard job order not found.' });

    const [[me]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    const isAssignedArtist = !!me?.employee_id && row.artist_employee_id === me.employee_id;
    if (!isAssignedArtist) {
      const [[page]] = await conn.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
      const [[perm]] = await conn.query(
        'SELECT can_edit AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?',
        [req.user.id, page?.id],
      );
      if (!perm?.allowed) return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }

    if (row.status === CANCELLED_STATUS) return res.status(409).json({ error: 'This job order has been cancelled.' });
    if (!ARTIST_WORKING_SUB_STATUSES.includes(row.sub_status)) {
      return res.status(409).json({ error: 'This job order is not ready for Sales Approval.' });
    }

    await conn.beginTransaction();
    await conn.query(
      'UPDATE non_standard_job_orders SET sub_status = ?, updated_at = NOW() WHERE id = ?',
      [SUB_SALES_APPROVAL, req.params.id],
    );
    await conn.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
       VALUES (?, 'nstdjo_sales_approval', ?, ?, 'NonStandardJobOrder', ?)`,
      [row.created_by_user_id, `${row.nstdjo_no} is ready for your sign-off`,
        'The artist has finished the layout and sent it for Sales Approval.', req.params.id],
    );
    await logAudit(conn, {
      id: req.params.id, userId: req.user.id, eventType: 'Status Change',
      fieldName: 'sub_status', oldValue: row.sub_status, newValue: SUB_SALES_APPROVAL,
    });
    await conn.commit();
    res.json({ id: Number(req.params.id), status: row.status, sub_status: SUB_SALES_APPROVAL });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// Sales signs off the finished layout. This is the end of the line for a Non-Standard Job
// Order -- unlike a Job Order, which goes to "Released" and on into production, there is
// nothing downstream here, so the order is COMPLETED.
router.put('/:id/approve-sales', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[row]] = await conn.query(
      'SELECT id, nstdjo_no, status, sub_status, artist_employee_id FROM non_standard_job_orders WHERE id = ?',
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Non-standard job order not found.' });
    if (row.status === CANCELLED_STATUS) return res.status(409).json({ error: 'This job order has been cancelled.' });
    if (row.sub_status !== SUB_SALES_APPROVAL) {
      return res.status(409).json({ error: 'This job order is not pending Sales Approval.' });
    }

    await conn.beginTransaction();
    await conn.query(
      'UPDATE non_standard_job_orders SET status = ?, sub_status = ?, updated_at = NOW() WHERE id = ?',
      [COMPLETED_STATUS, SUB_APPROVED, req.params.id],
    );
    await logAudit(conn, {
      id: req.params.id, userId: req.user.id, eventType: 'Approved',
      fieldName: 'status', oldValue: row.status, newValue: COMPLETED_STATUS,
    });
    await logAudit(conn, {
      id: req.params.id, userId: req.user.id, eventType: 'Status Change',
      fieldName: 'sub_status', oldValue: row.sub_status, newValue: SUB_APPROVED,
    });
    await conn.commit();
    res.json({ id: Number(req.params.id), status: COMPLETED_STATUS, sub_status: SUB_APPROVED });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// The other half of the SBU gate: an approver bounces the order back to Sales for
// changes instead of clearing it. Same authorisation as approve -- only a tagged
// approver -- and it stays out of the design queue while it sits in Sales Revision.
router.put('/:id/request-revision', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[row]] = await conn.query(
      'SELECT id, nstdjo_no, status, sub_status, created_by_user_id FROM non_standard_job_orders WHERE id = ?',
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Non-standard job order not found.' });
    if (row.status === CANCELLED_STATUS) return res.status(409).json({ error: 'This job order has been cancelled.' });
    if (row.sub_status !== SUB_SBU_APPROVAL) {
      return res.status(409).json({ error: 'Only a job order awaiting SBU approval can be sent back for revision.' });
    }

    const [[isApprover]] = await conn.query(
      'SELECT 1 AS x FROM non_standard_job_order_approvers WHERE non_standard_job_order_id = ? AND user_id = ?',
      [req.params.id, req.user.id],
    );
    if (!isApprover) {
      return res.status(403).json({ error: 'Only this job order\'s designated approver(s) can send it back for revision.' });
    }

    const remarks = (req.body?.remarks || '').trim();
    await conn.beginTransaction();
    await conn.query(
      'UPDATE non_standard_job_orders SET sub_status = ?, updated_at = NOW() WHERE id = ?',
      [SUB_SALES_REVISION, req.params.id],
    );
    await conn.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
       VALUES (?, 'nstdjo_for_revision', ?, ?, 'NonStandardJobOrder', ?)`,
      [row.created_by_user_id, `${row.nstdjo_no} was sent back for revision`,
        remarks || 'Your non-standard job order needs changes before it can be approved.', req.params.id],
    );
    await logAudit(conn, {
      id: req.params.id, userId: req.user.id, eventType: 'Status Change',
      fieldName: 'sub_status', oldValue: row.sub_status, newValue: SUB_SALES_REVISION,
    });
    if (remarks) {
      await logAudit(conn, {
        id: req.params.id, userId: req.user.id, eventType: 'Updated',
        fieldName: 'revision_remarks', newValue: remarks,
      });
    }
    await conn.commit();
    res.json({ id: Number(req.params.id), status: row.status, sub_status: SUB_SALES_REVISION });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// The Design Supervisor gate: the role flag, with generic can_edit as the fallback for
// admins/managers who are not personally flagged -- the same shape as
// /job-orders/:id/assign-design. Shared by the two things a supervisor does with an order
// sitting in their queue: hand it to an artist, or send it back to Sales.
async function isDesignSupervisor(userId) {
  const [[user]] = await pool.query('SELECT is_design_supervisor FROM users WHERE id = ?', [userId]);
  if (user?.is_design_supervisor) return true;
  const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  const [[perm]] = await pool.query(
    'SELECT can_edit AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?',
    [userId, page?.id],
  );
  return !!perm?.allowed;
}

// The Design Supervisor sends an order in their queue back to Sales instead of assigning
// an artist -- the spec is wrong or incomplete and no artist should start on it. The
// mirror of the approver's /request-revision, one step further down the workflow.
//
// Only from "For Design Supervisor", i.e. before anyone has been handed the work. Once an
// artist is on it there are layout timestamps and incentive figures accruing against the
// order, and pulling it out from under them is a different decision with different
// consequences -- the artist-revision loop already exists for that.
//
// forwarded_at IS CLEARED, and that is what makes the round trip work at all. Forward is a
// once-only action guarded by that column, so an order bounced back to Sales with it still
// set could be edited and re-approved but never handed to Design again -- it would strand
// on "SBU Approved" with no button able to move it. Clearing it returns the order to the
// pre-forward state, which is exactly what it now is.
router.put('/:id/design-request-revision', requireAuth, async (req, res, next) => {
  if (!await isDesignSupervisor(req.user.id)) {
    return res.status(403).json({ error: 'Only a Design Supervisor can send a job order back to Sales.' });
  }
  const conn = await pool.getConnection();
  try {
    const [[row]] = await conn.query(
      'SELECT id, nstdjo_no, status, sub_status, created_by_user_id FROM non_standard_job_orders WHERE id = ?',
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Non-standard job order not found.' });
    if (row.status === CANCELLED_STATUS) return res.status(409).json({ error: 'This job order has been cancelled.' });
    // Status carries the design stage, sub_status the position within it. Both are checked:
    // either one being wrong means this is not an order the supervisor may bounce.
    if (row.status !== DESIGN_QUEUE_STATUS) {
      return res.status(409).json({ error: `This job order is ${row.status} and is not in the design stage.` });
    }
    if (row.sub_status !== SUB_FOR_DESIGN) {
      return res.status(409).json({
        error: 'Only a job order waiting for an artist can be sent back to Sales for revision.',
      });
    }

    const remarks = (req.body?.remarks || '').trim();
    await conn.beginTransaction();
    await conn.query(
      'UPDATE non_standard_job_orders SET sub_status = ?, forwarded_at = NULL, updated_at = NOW() WHERE id = ?',
      [SUB_SALES_REVISION_DESIGN, req.params.id],
    );
    // The raiser is who edits it next, so the raiser is who gets told. Reuses the approver's
    // notification type: to Sales it means the same thing either way -- their order needs
    // changes before it can go anywhere -- and the title says who sent it back.
    await conn.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
       VALUES (?, 'nstdjo_for_revision', ?, ?, 'NonStandardJobOrder', ?)`,
      [row.created_by_user_id, `${row.nstdjo_no} was sent back by the design supervisor`,
        remarks || 'Your non-standard job order needs changes before an artist can be assigned.',
        req.params.id],
    );
    await logAudit(conn, {
      id: req.params.id, userId: req.user.id, eventType: 'Status Change',
      fieldName: 'sub_status', oldValue: row.sub_status, newValue: SUB_SALES_REVISION_DESIGN,
    });
    if (remarks) {
      await logAudit(conn, {
        id: req.params.id, userId: req.user.id, eventType: 'Updated',
        fieldName: 'revision_remarks', newValue: remarks,
      });
    }
    await conn.commit();
    res.json({ id: Number(req.params.id), status: row.status, sub_status: SUB_SALES_REVISION_DESIGN });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// A Design Supervisor picks the artist for an order sitting in their queue, which hands
// it on to that artist (Sub Status -> "For Artist"). Reassignment stays open while the
// order is still in the design queue.
router.put('/:id/assign-artist', requireAuth, async (req, res, next) => {
  if (!await isDesignSupervisor(req.user.id)) {
    return res.status(403).json({ error: 'Only a Design Supervisor can assign an artist.' });
  }

  const { artist_employee_id: artistId, layout_job_type_id: layoutJobTypeId, planned_start_at: plannedStartAt } = req.body || {};
  if (!artistId) return res.status(400).json({ error: 'Artist is required.' });
  if (!plannedStartAt) return res.status(400).json({ error: 'Planned Start is required.' });
  const layoutQty = Number(req.body?.layout_qty);
  if (!Number.isFinite(layoutQty) || layoutQty <= 0) return res.status(400).json({ error: 'Qty must be a positive number.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.query(
      `SELECT nstdjo_no, description, status, sub_status, artist_employee_id, job_type_id, layout_job_type_id
         FROM non_standard_job_orders WHERE id = ?`, [req.params.id],
    );
    if (!row) { await conn.rollback(); return res.status(404).json({ error: 'Non-standard job order not found.' }); }
    if (row.status === CANCELLED_STATUS) {
      await conn.rollback();
      return res.status(409).json({ error: 'This job order is cancelled -- an artist can no longer be assigned.' });
    }
    if (!DESIGN_QUEUE_SUB_STATUSES.includes(row.sub_status)) {
      await conn.rollback();
      return res.status(409).json({ error: 'This job order has not been forwarded to the design supervisor yet.' });
    }
    const [[artist]] = await conn.query('SELECT id FROM employees WHERE id = ? AND is_active = TRUE', [artistId]);
    if (!artist) { await conn.rollback(); return res.status(400).json({ error: 'Choose an active employee as the artist.' }); }

    // The layout job type stays within the order's own job type, the same cascade the
    // creation form enforces. Left optional because CUTTING LIST has no PMS job types at
    // all -- such an order would otherwise be impossible to assign.
    let plannedEndAt = null;
    if (layoutJobTypeId) {
      const [[layoutJobType]] = await conn.query(
        'SELECT id, job_type_id, minutes_consume FROM pms_job_types WHERE id = ?', [layoutJobTypeId],
      );
      if (!layoutJobType) { await conn.rollback(); return res.status(400).json({ error: 'Invalid Layout - Job Type.' }); }
      if (String(layoutJobType.job_type_id) !== String(row.job_type_id)) {
        await conn.rollback();
        return res.status(400).json({ error: 'That Layout - Job Type does not belong to this order\'s job type.' });
      }
      // Planned End = Planned Start + (allotted minutes for one unit x Qty), matching
      // how a Job Order's layout window is derived.
      plannedEndAt = new Date(new Date(plannedStartAt).getTime() + Number(layoutJobType.minutes_consume || 0) * layoutQty * 60 * 1000);
    }

    await conn.query(
      `UPDATE non_standard_job_orders
          SET artist_employee_id = ?, layout_job_type_id = ?, layout_qty = ?,
              planned_start_at = ?, planned_end_at = ?, sub_status = ?, updated_at = NOW()
        WHERE id = ?`,
      [artistId, layoutJobTypeId || null, layoutQty, plannedStartAt, plannedEndAt, SUB_FOR_ARTIST, req.params.id],
    );
    await logAudit(conn, {
      id: req.params.id, userId: req.user.id, eventType: 'Updated',
      fieldName: 'artist_employee_id', oldValue: row.artist_employee_id, newValue: artistId,
    });
    if (String(row.layout_job_type_id || '') !== String(layoutJobTypeId || '')) {
      await logAudit(conn, {
        id: req.params.id, userId: req.user.id, eventType: 'Updated',
        fieldName: 'layout_job_type_id', oldValue: row.layout_job_type_id, newValue: layoutJobTypeId || null,
      });
    }
    await logAudit(conn, {
      id: req.params.id, userId: req.user.id, eventType: 'Updated',
      fieldName: 'planned_start_at', newValue: plannedStartAt,
    });
    if (row.sub_status !== SUB_FOR_ARTIST) {
      await logAudit(conn, {
        id: req.params.id, userId: req.user.id, eventType: 'Status Change',
        fieldName: 'sub_status', oldValue: row.sub_status, newValue: SUB_FOR_ARTIST,
      });
    }
    // Tell the artist the work is theirs. Sent on a reassignment too -- the new artist
    // needs telling just as much as the first one did.
    await notifyAssignedArtist(conn, {
      artistEmployeeId: artistId,
      title: `${row.nstdjo_no} has been assigned to you`,
      message: row.description ? String(row.description).slice(0, 500) : null,
      relatedType: 'NonStandardJobOrder',
      relatedId: req.params.id,
    });
    await conn.commit();
    res.json({
      id: Number(req.params.id), artist_employee_id: Number(artistId),
      layout_job_type_id: layoutJobTypeId || null, layout_qty: layoutQty,
      planned_start_at: plannedStartAt, planned_end_at: plannedEndAt, sub_status: SUB_FOR_ARTIST,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.set_by_user_id
        WHERE a.auditable_type = 'NonStandardJobOrder' AND a.auditable_id = ?
        ORDER BY a.set_at DESC, a.id DESC`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});


// Sales sends the layout back for changes instead of signing it off. The other half of the
// Sales Approval decision, and the mirror of /job-orders/:id/request-revision.
//
// Named "sales-request-revision" and not "request-revision" because this module already has a
// /request-revision: that one is the SBU approver bouncing a *brand-new* order back to Sales
// before any design work has happened. This one is Sales bouncing a *finished layout* back to
// the artist. Two different people, two different stages -- so two different routes.
//
// THE TIMER IS NOT RESET, and this is where it deliberately diverges from Job Orders. The JO
// version clears layout_started_at/layout_ended_at and deletes the Play/Hold sessions so the
// artist's clock restarts. Here the timestamps are left exactly as they are: an NSTDJO artist's
// incentive and performance figures are derived from them, and wiping them on a revision would
// quietly erase work already done and already earned. A revision notifies; it does not rewrite
// what the artist has already put in.
router.put('/:id/sales-request-revision', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[row]] = await conn.query(
      `SELECT id, nstdjo_no, status, sub_status, artist_employee_id, sales_revision_count
         FROM non_standard_job_orders WHERE id = ?`,
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Non-standard job order not found.' });
    if (row.status === CANCELLED_STATUS) return res.status(409).json({ error: 'This job order has been cancelled.' });
    if (row.sub_status !== SUB_SALES_APPROVAL) {
      return res.status(409).json({ error: 'This job order is not pending Sales Approval.' });
    }
    const used = Number(row.sales_revision_count) || 0;
    if (used >= MAX_SALES_REVISIONS) {
      return res.status(409).json({
        error: `This job order has already used all ${MAX_SALES_REVISIONS} revisions. Approve it, or cancel it and raise a new one.`,
      });
    }
    // A revision with no reason is just a refusal, and the artist is left guessing at what to
    // change -- which is exactly the situation this feature exists to end.
    const remarks = String(req.body?.remarks || '').trim();
    if (!remarks) return res.status(400).json({ error: 'Say what needs changing so the artist knows what to alter.' });

    await conn.beginTransaction();
    const revisionNo = used + 1;
    await conn.query(
      `UPDATE non_standard_job_orders
          SET sub_status = ?, sales_revision_count = ?, last_revision_at = NOW(),
              last_revision_note = ?, updated_at = NOW()
        WHERE id = ?`,
      [SUB_FOR_ARTIST_REVISION, revisionNo, remarks.slice(0, 500), req.params.id],
    );
    // Told to the artist, not to the raiser -- they are the one who has to act on it.
    await notifyAssignedArtist(conn, {
      artistEmployeeId: row.artist_employee_id,
      title: `${row.nstdjo_no} needs a revision`,
      message: `Sales asked for changes (revision ${revisionNo} of ${MAX_SALES_REVISIONS}): ${remarks.slice(0, 300)}`,
      relatedType: 'NonStandardJobOrder',
      relatedId: Number(req.params.id),
    });
    await logAudit(conn, {
      id: req.params.id, userId: req.user.id, eventType: 'Status Change',
      fieldName: 'sub_status', oldValue: row.sub_status, newValue: SUB_FOR_ARTIST_REVISION,
    });
    await logAudit(conn, {
      id: req.params.id, userId: req.user.id, eventType: 'Updated',
      fieldName: `revision_remarks (${revisionNo} of ${MAX_SALES_REVISIONS})`, newValue: remarks,
    });
    await conn.commit();
    res.json({
      id: Number(req.params.id), status: row.status, sub_status: SUB_FOR_ARTIST_REVISION,
      sales_revision_count: revisionNo, revisions_remaining: MAX_SALES_REVISIONS - revisionNo,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// Copy an order into a new one, whatever state the original is in.
//
// Repeat work is ordinary here -- the same job for the same customer next month -- and re-keying
// every material and process line by hand is where mistakes get made. Allowed from any status,
// including Cancelled and COMPLETED, because those are the two people most often want to copy:
// a finished job worth repeating, or a cancelled one worth raising again properly.
//
// The copy is a NEW order raised by whoever pressed the button, not a clone of the original's
// progress. It starts at the beginning of the workflow and goes through the presser's own
// department approvers -- copying the original's approvers would send it to the wrong people
// when the two raisers sit in different departments. Nothing about the artist assignment,
// timers, approvals or audit history is carried across; only the customer, job details and the
// material/process lines, which are the reason anyone replicates an order at all.
router.post('/:id/replicate', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[src]] = await conn.query('SELECT * FROM non_standard_job_orders WHERE id = ?', [req.params.id]);
    if (!src) return res.status(404).json({ error: 'Non-standard job order not found.' });

    const branch = await defaultBranch(req.user.id);
    if (!branch.employee_id) return res.status(400).json({ error: 'Your user account needs an assigned employee before a non-standard job order can be saved.' });
    if (!branch.sales_division_id) return res.status(400).json({ error: 'Your default User Branch needs a department before a non-standard job order can be saved.' });

    const [approvers] = await conn.query(
      `SELECT dta.user_id FROM users u
         JOIN employees e ON e.id = u.employee_id
         JOIN departments d ON d.id = e.department_id
         JOIN department_ticket_approvers dta ON dta.department_id = d.id
        WHERE u.id = ?`,
      [req.user.id],
    );
    const initialSubStatus = approvers.length ? SUB_SBU_APPROVAL : SUB_PENDING;

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO non_standard_job_orders
       (nstdjo_no, customer_id, contact_person_id, contact_email, contact_title, contact_phone, memo, date_created,
        job_location_id, job_type_id, job_type, site_inspection_subtype, pms_job_type_id, description, quantity,
        shipping_address, delivery_date, delivery_time, sales_rep_id, sales_division_id,
        status, sub_status, created_by_user_id)
       VALUES ('PENDING', ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [src.customer_id, src.contact_person_id, src.contact_email, src.contact_title, src.contact_phone,
        src.memo, branch.location_id || src.job_location_id, src.job_type_id, src.job_type,
        src.site_inspection_subtype, src.pms_job_type_id, src.description, src.quantity,
        src.shipping_address, src.delivery_date, src.delivery_time, branch.employee_id, branch.sales_division_id,
        INITIAL_STATUS, initialSubStatus, req.user.id],
    );
    const newId = result.insertId;
    const nstdjoNo = `NSTDJO-${newId}`;
    await conn.query('UPDATE non_standard_job_orders SET nstdjo_no = ? WHERE id = ?', [nstdjoNo, newId]);

    // Copied verbatim, artist_incentive included: it was priced off the process price when the
    // original was saved, and the same lines at the same prices must earn the same figure.
    const [mats] = await conn.query(
      'SELECT * FROM non_standard_job_order_materials WHERE non_standard_job_order_id = ? ORDER BY line_no, id',
      [req.params.id],
    );
    for (const m of mats) {
      await conn.query(
        `INSERT INTO non_standard_job_order_materials
         (non_standard_job_order_id, line_no, process_id, process_qty, process_price, artist_incentive,
          item_id, artist_remarks, length, width, uom, qty, total, unit, sales_remarks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId, m.line_no, m.process_id, m.process_qty, m.process_price, m.artist_incentive,
          m.item_id, m.artist_remarks, m.length, m.width, m.uom, m.qty, m.total, m.unit, m.sales_remarks],
      );
    }

    for (const { user_id: approverUserId } of approvers) {
      await conn.query(
        'INSERT INTO non_standard_job_order_approvers (non_standard_job_order_id, user_id) VALUES (?, ?)',
        [newId, approverUserId],
      );
      await conn.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, 'nstdjo_pending_approval', ?, ?, 'NonStandardJobOrder', ?)`,
        [approverUserId, `${nstdjoNo} needs your approval`, String(src.description || '').slice(0, 500), newId],
      );
    }

    // Recorded on the copy so its origin is never a guess -- a replicated order is otherwise
    // indistinguishable from one keyed by hand.
    await logAudit(conn, {
      id: newId, userId: req.user.id, eventType: 'Created',
      fieldName: 'nstdjo_no', newValue: `${nstdjoNo} (replicated from ${src.nstdjo_no})`,
    });
    await conn.commit();
    res.status(201).json({
      id: newId, nstdjo_no: nstdjoNo, replicated_from: src.nstdjo_no,
      status: INITIAL_STATUS, sub_status: initialSubStatus, lines: mats.length,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});


// Approve several job orders in one go.
//
// Deliberately ONE endpoint covering both gates rather than one per gate. An approver looking
// at the list sees a single queue of "things waiting on me" -- some sitting at SBU Approval,
// some at Sales Approval -- and asking them to sort their own selection into two piles by a
// distinction the list barely shows is a good way to get the wrong button pressed. Each order
// is approved through whichever gate its own sub_status calls for, with that gate's own
// authorisation checked on that order.
//
// Each order commits in its OWN transaction. One rejected order must not undo the approvals of
// the others -- a batch that silently rolls back nineteen good approvals because the twentieth
// was already cancelled is far worse than a batch that reports one failure. Nothing is skipped
// silently: every id comes back either approved or with the reason it was not.
const MAX_BULK_APPROVE = 100;

router.post('/bulk-approve', requireAuth, async (req, res, next) => {
  try {
    // Positive integers only. Number(null) is 0 and Number([]) is 0, both of which pass
    // Number.isInteger -- so a selection of junk would arrive as a request to approve order 0
    // rather than as the empty selection it actually is.
    const ids = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];
    if (!ids.length) return res.status(400).json({ error: 'Select at least one job order to approve.' });
    if (ids.length > MAX_BULK_APPROVE) {
      return res.status(400).json({ error: `Approve at most ${MAX_BULK_APPROVE} job orders at a time.` });
    }

    // Whether this user holds page-level approval rights, which is what the Sales gate tests.
    // Read once rather than per order -- it cannot change mid-batch.
    const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
    const [[perm]] = await pool.query(
      'SELECT can_approve AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?',
      [req.user.id, page?.id],
    );
    const canApproveSales = !!perm?.allowed;

    const approved = [];
    const skipped = [];

    for (const id of ids) {
      const conn = await pool.getConnection();
      try {
        const [[row]] = await conn.query(
          `SELECT id, nstdjo_no, status, sub_status, approved_at, artist_employee_id, created_by_user_id, sales_division_id
             FROM non_standard_job_orders WHERE id = ?`,
          [id],
        );
        if (!row) { skipped.push({ id, nstdjo_no: null, reason: 'No longer exists.' }); continue; }
        const ref = { id, nstdjo_no: row.nstdjo_no };
        if (row.status === CANCELLED_STATUS) { skipped.push({ ...ref, reason: 'Cancelled.' }); continue; }

        if (row.sub_status === SUB_SBU_APPROVAL) {
          if (row.approved_at) { skipped.push({ ...ref, reason: 'Already approved.' }); continue; }
          const [[isApprover]] = await conn.query(
            'SELECT 1 AS x FROM non_standard_job_order_approvers WHERE non_standard_job_order_id = ? AND user_id = ?',
            [id, req.user.id],
          );
          if (!isApprover && !(await sbuCanApproveDepartment(req.user.id, row.sales_division_id))) {
            skipped.push({ ...ref, reason: 'You are not a designated approver for this one.' }); continue;
          }

          await conn.beginTransaction();
          await conn.query(
            'UPDATE non_standard_job_orders SET approved_by_user_id = ?, approved_at = NOW(), sub_status = ?, updated_at = NOW() WHERE id = ?',
            [req.user.id, SUB_SBU_APPROVED, id],
          );
          await conn.query(
            `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
             VALUES (?, 'nstdjo_approved', ?, ?, 'NonStandardJobOrder', ?)`,
            [row.created_by_user_id, `${row.nstdjo_no} has been approved`,
              `Your non-standard job order ${row.nstdjo_no} is approved and can now be forwarded to the Design Supervisor.`, id],
          );
          await logAudit(conn, { id, userId: req.user.id, eventType: 'Approved', fieldName: 'approved_at', newValue: 'approved' });
          await logAudit(conn, {
            id, userId: req.user.id, eventType: 'Status Change',
            fieldName: 'sub_status', oldValue: row.sub_status, newValue: SUB_SBU_APPROVED,
          });
          await conn.commit();
          approved.push({ ...ref, gate: 'SBU', status: row.status, sub_status: SUB_SBU_APPROVED });
          continue;
        }

        if (row.sub_status === SUB_SALES_APPROVAL) {
          if (!canApproveSales) { skipped.push({ ...ref, reason: 'You do not have approval rights on this page.' }); continue; }

          await conn.beginTransaction();
          await conn.query(
            'UPDATE non_standard_job_orders SET status = ?, sub_status = ?, updated_at = NOW() WHERE id = ?',
            [COMPLETED_STATUS, SUB_APPROVED, id],
          );
          await logAudit(conn, {
            id, userId: req.user.id, eventType: 'Approved',
            fieldName: 'status', oldValue: row.status, newValue: COMPLETED_STATUS,
          });
          await logAudit(conn, {
            id, userId: req.user.id, eventType: 'Status Change',
            fieldName: 'sub_status', oldValue: row.sub_status, newValue: SUB_APPROVED,
          });
          await conn.commit();
          approved.push({ ...ref, gate: 'Sales', status: COMPLETED_STATUS, sub_status: SUB_APPROVED });
          continue;
        }

        skipped.push({ ...ref, reason: `Not awaiting approval (${row.sub_status}).` });
      } catch (err) {
        await conn.rollback();
        // One order failing is reported against that order; the rest of the batch continues.
        skipped.push({ id, nstdjo_no: null, reason: err.sqlMessage || err.message || 'Could not be approved.' });
      } finally { conn.release(); }
    }

    res.json({ approved, skipped, requested: ids.length });
  } catch (err) { next(err); }
});

module.exports = router;
