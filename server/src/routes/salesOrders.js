const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');

const router = express.Router();
const ROUTE = '/sales-orders';

const STATUS_VALUES = [
  'pending_for_jo', 'jo_in_process', 'pending_delivery', 'partially_delivered',
  'pending_billing', 'pending_billing_partially_delivered', 'billed', 'cancelled',
];

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const {
      status, search, sales_rep_id: salesRepId, office_location_id: officeLocationId, as_of: asOf,
      customer_id: customerId, page = '1', limit = '10',
    } = req.query;

    const commonWhere = [];
    const commonParams = [];
    if (salesRepId) { commonWhere.push('so.sales_rep_id = ?'); commonParams.push(salesRepId); }
    if (officeLocationId) { commonWhere.push('so.office_location_id = ?'); commonParams.push(officeLocationId); }
    if (asOf) { commonWhere.push('so.date_created <= ?'); commonParams.push(asOf); }
    if (customerId) { commonWhere.push('so.customer_id = ?'); commonParams.push(customerId); }
    if (search) {
      commonWhere.push('(so.sales_order_no LIKE ? OR e.estimate_no LIKE ? OR c.name LIKE ? OR so.contract_description LIKE ?)');
      commonParams.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    // Account Officers only ever see their own sales orders; Supervisors see their own
    // plus their direct reports' -- everyone else is unrestricted.
    const scope = await getSalesRepEmployeeScope(req.user.id);
    if (scope) { commonWhere.push('so.sales_rep_id IN (?)'); commonParams.push(scope); }

    const where = [...commonWhere];
    const params = [...commonParams];
    if (status && STATUS_VALUES.includes(status)) { where.push('so.status = ?'); params.push(status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const commonWhereSql = commonWhere.length ? `WHERE ${commonWhere.join(' AND ')}` : '';

    const baseFrom = `FROM sales_orders so
       LEFT JOIN estimates e ON e.id = so.estimate_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN employees pb ON pb.id = so.prepared_by_id
       LEFT JOIN locations loc ON loc.id = so.office_location_id`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${whereSql}`, params);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.query(
      `SELECT so.*, e.estimate_no, c.name AS customer_name, CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(pb.first_name, ' ', pb.last_name) AS prepared_by_name, loc.location_name
       ${baseFrom} ${whereSql}
       ORDER BY so.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const [countRows] = await pool.query(
      `SELECT so.status, COUNT(*) AS count ${baseFrom} ${commonWhereSql} GROUP BY so.status`,
      commonParams
    );
    const counts = Object.fromEntries(STATUS_VALUES.map((s) => [s, 0]));
    countRows.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status] = r.count; });

    res.json({ rows, total, page: pageNum, limit: limitNum, counts });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[so]] = await pool.query(
      `SELECT so.*, e.estimate_no, c.name AS customer_name, cc.contact_name,
              sd.name AS sales_division_name, loc.location_name AS office_location_name,
              bp.po_number AS blanket_po_no,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(pb.first_name, ' ', pb.last_name) AS prepared_by_name,
              CONCAT(ap.first_name, ' ', ap.last_name) AS approved_by_name
       FROM sales_orders so
       LEFT JOIN estimates e ON e.id = so.estimate_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
       LEFT JOIN locations loc ON loc.id = so.office_location_id
       LEFT JOIN blanket_pos bp ON bp.id = so.blanket_po_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN employees pb ON pb.id = so.prepared_by_id
       LEFT JOIN employees ap ON ap.id = so.approved_by_id
       WHERE so.id = ?`,
      [req.params.id]
    );
    if (!so) return res.status(404).json({ error: 'Not found' });
    // Defense in depth -- a scoped user can't view someone else's sales order just by
    // guessing/pasting its URL, even though the list already filters it out.
    const scope = await getSalesRepEmployeeScope(req.user.id);
    if (scope && !scope.includes(so.sales_rep_id)) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT sol.*, jt.display_name AS job_type_name, loc.location_name AS job_location_name, t.code AS tax_code, t.rate AS tax_rate,
              jo.job_order_no, jo.status AS job_order_status,
              jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, jo.quantity_invoiced
       FROM sales_order_lines sol
       LEFT JOIN job_types jt ON jt.id = sol.job_type_id
       LEFT JOIN locations loc ON loc.id = sol.job_location_id
       LEFT JOIN taxes t ON t.id = sol.tax_code_id
       LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
       WHERE sol.sales_order_id = ? ORDER BY sol.line_no`,
      [req.params.id]
    );

    res.json({ ...so, lines });
  } catch (err) {
    next(err);
  }
});

// Mirrors the real system's "Create JO" cell on a Sales Order line: turns that line
// into a Job Order (a deliberately minimal production-record stand-in, not the full
// production/QI/delivery/invoicing pipeline the real system has behind it).
// Creating a JO from a line is an "add" (a sales rep forwarding their order to production),
// not an edit of the sales order -- gate it on can_add, which sales accounts have.
router.post('/:id/lines/:lineId/create-jo', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[so]] = await conn.query('SELECT * FROM sales_orders WHERE id = ?', [req.params.id]);
    const [[line]] = await conn.query(
      'SELECT * FROM sales_order_lines WHERE id = ? AND sales_order_id = ?',
      [req.params.lineId, req.params.id]
    );
    if (!so || !line) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    if (line.job_order_id) {
      await conn.rollback();
      return res.status(409).json({ error: 'This line already has a Job Order' });
    }

    // Job Order number: JO-<soNumber>-<sequence>-<totalLines> -- sequence is this line's position,
    // total is how many lines the SO has (so JO-63615-2-3 reads "line 2 of 3").
    const soNumericPart = so.sales_order_no.replace(/\D/g, '');
    const [[lineCount]] = await conn.query('SELECT COUNT(*) AS n FROM sales_order_lines WHERE sales_order_id = ?', [so.id]);
    const jobOrderNo = `JO-${soNumericPart}-${line.line_no}-${lineCount.n}`;
    const [result] = await conn.query(
      `INSERT INTO job_orders
         (job_order_no, sales_order_line_id, sales_order_id, job_type_id, job_location_id, description, quantity, units,
          length, width, height, memo, contact_email, contact_title, contact_phone, shipping_address, sales_rep_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [jobOrderNo, line.id, req.params.id, line.job_type_id, line.job_location_id, line.description, line.quantity, line.units,
        line.length, line.width, line.height, line.memo,
        so.contact_email, so.contact_title, so.contact_phone, so.shipping_address, so.sales_rep_id]
    );
    const jobOrderId = result.insertId;
    await conn.query('UPDATE sales_order_lines SET job_order_id = ? WHERE id = ?', [jobOrderId, line.id]);

    // Copy the originating estimate process line's cost breakdown into the Job Order's
    // own Materials/Processes tabs -- this is where that data actually gets consumed
    // downstream, since Sales Order lines themselves stay flat (no nested process rows).
    if (line.estimate_job_order_id) {
      const [processes] = await conn.query(
        'SELECT * FROM estimate_job_order_processes WHERE estimate_job_order_id = ? ORDER BY line_no',
        [line.estimate_job_order_id]
      );
      for (const p of processes) {
        await conn.query(
          `INSERT INTO job_order_processes
             (job_order_id, line_no, process_id, process_qty, process_uom, category, parts, item_id, length, width, uom,
              qty, total, unit, remarks, memo, process_cost, material_cost, total_cost)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [jobOrderId, p.line_no, p.process_id, p.process_qty, p.process_uom, p.category, p.parts, p.item_id, p.length, p.width,
            p.uom, p.qty, p.total, p.unit, p.remarks, p.memo, p.process_cost, p.material_cost, p.total_cost]
        );
      }
    }

    // The first line getting a JO moves the whole order out of "Pending for JO".
    await conn.query(
      "UPDATE sales_orders SET status = 'jo_in_process', updated_at = NOW() WHERE id = ? AND status = 'pending_for_jo'",
      [req.params.id]
    );
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('JobOrder', ?, 'Created', 'status', NULL, ?, ?)`,
      [jobOrderId, 'Planned - Pending for BOM', req.user.id]
    );
    await conn.commit();
    const [[jobOrder]] = await pool.query('SELECT * FROM job_orders WHERE id = ?', [jobOrderId]);
    res.status(201).json(jobOrder);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------------------------------
// Attachments carried over from the originating estimate
// ---------------------------------------------------------------------------------------
//
// The PO, conforme or proof of payment someone scanned onto the estimate is the same
// document the order is worked against, so it is exposed here rather than making whoever
// opens the Sales Order navigate back to the estimate to find it. The rows are read-only
// on this side: the files belong to the estimate, and letting an order add or delete them
// would leave the two screens disagreeing about what was actually submitted.
//
// Gated on the Sales Order's own can_view (not the estimate's) -- someone who can see the
// order is entitled to the paperwork behind it, and plenty of order-side accounts have no
// estimate permission at all.
async function estimateIdForSalesOrder(req) {
  const [[so]] = await pool.query('SELECT id, estimate_id, sales_rep_id FROM sales_orders WHERE id = ?', [req.params.id]);
  if (!so) return null;
  // Same defense in depth as the detail route -- a scoped user must not reach another rep's
  // paperwork by pasting an id.
  const scope = await getSalesRepEmployeeScope(req.user.id);
  if (scope && !scope.includes(so.sales_rep_id)) return null;
  return so.estimate_id;
}

router.get('/:id/attachments', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const estimateId = await estimateIdForSalesOrder(req);
    if (estimateId === null) return res.status(404).json({ error: 'Not found' });
    // A sales order with no estimate behind it (imported or non-standard) simply has none.
    if (!estimateId) return res.json([]);

    const [rows] = await pool.query(
      `SELECT a.id, a.file_name, a.mime_type, a.size_bytes, a.created_at, u.display_name AS uploaded_by_name
         FROM estimate_attachments a
         LEFT JOIN users u ON u.id = a.uploaded_by_user_id
        WHERE a.estimate_id = ? ORDER BY a.id`,
      [estimateId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id/attachments/:attachmentId/file', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const estimateId = await estimateIdForSalesOrder(req);
    if (!estimateId) return res.status(404).json({ error: 'Not found' });

    // Matched against the estimate id as well as the attachment id, so an attachment on
    // someone else's estimate cannot be pulled through this order's URL.
    const [[row]] = await pool.query(
      'SELECT file_name, mime_type, file_data FROM estimate_attachments WHERE id = ? AND estimate_id = ?',
      [req.params.attachmentId, estimateId],
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${row.file_name.replace(/"/g, '')}"`);
    res.send(row.file_data);
  } catch (err) { next(err); }
});

module.exports = router;
