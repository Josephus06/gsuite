const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');

const router = express.Router();
const ROUTE = '/estimates';

const HEADER_FIELDS = [
  'date_created', 'customer_id', 'contact_person_id', 'contact_email', 'contact_title', 'contact_phone',
  'blanket_po_id', 'blanket_po_memo', 'sales_rep_id', 'sales_division_id', 'office_location_id',
  'contract_description', 'memo', 'shipping_address', 'has_multiple_shipping', 'production_lead_time',
  'price_validity', 'order_confirmation_type', 'print_warranty', 'print_warranty_term', 'structure_warranty',
  'structure_warranty_term', 'electrical_warranty', 'electrical_warranty_term', 'prepared_by_id', 'approved_by_id',
  'credit_term', 'credit_limit', 'credit_balance', 'bill_to_contact_number', 'status',
  'subtotal', 'discount_total', 'net_of_tax', 'tax_total', 'total_amount', 'est_gp_rate', 'est_gp_amount',
];

const JOB_ORDER_FIELDS = [
  'nstdjo_no', 'job_type_id', 'job_location_id', 'description', 'quantity', 'units', 'price_per_unit', 'subtotal',
  'disc_percent', 'disc_per_unit', 'disc_amount', 'disc_price_per_unit', 'net_of_tax', 'tax_code_id', 'tax_amount',
  'gross_amount', 'length', 'width', 'height', 'uom', 'shipping', 'remarks', 'memo', 'delivery_date', 'delivery_time',
  'gp_rate', 'gp_amount',
];

const PROCESS_FIELDS = [
  'process_id', 'process_qty', 'process_uom', 'category', 'parts', 'item_id', 'length', 'width', 'uom', 'qty',
  'total', 'unit', 'process_price', 'process_disc_percent', 'process_disc_amount', 'disc_process_price',
  'material_price', 'material_disc_percent', 'material_disc_amount', 'disc_material_price', 'net_of_tax',
  'tax_code_id', 'tax_amount', 'gross_amount', 'shipping', 'remarks', 'memo', 'delivery_date', 'delivery_time',
  'gp_rate', 'process_cost', 'material_cost', 'total_cost', 'total_price',
];

// sales_order_lines mirrors estimate_job_orders minus nstdjo_no/disc_per_unit, which
// don't carry forward to the order snapshot.
const SALES_ORDER_LINE_FIELDS = JOB_ORDER_FIELDS.filter((f) => f !== 'nstdjo_no' && f !== 'disc_per_unit');
const SALES_ORDER_HEADER_FIELDS = [
  'estimate_id', 'date_created', 'customer_id', 'contact_person_id', 'contact_email', 'contact_title', 'contact_phone',
  'blanket_po_id', 'blanket_po_memo', 'sales_rep_id', 'sales_division_id', 'office_location_id',
  'contract_description', 'memo', 'shipping_address', 'production_lead_time', 'price_validity',
  'order_confirmation_type', 'prepared_by_id', 'approved_by_id', 'credit_term', 'credit_limit', 'credit_balance',
  'bill_to_contact_number', 'subtotal', 'discount_total', 'net_of_tax', 'tax_total', 'total_amount',
  'est_gp_rate', 'est_gp_amount',
];

// Snapshots the estimate (header + job order lines) into a brand-new Sales Order --
// this is what the real system does the moment an estimate reaches final "Approved".
// It's a copy, not a live reference, so later edits/replications of the estimate don't
// retroactively change an order that's already been placed.
function n(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }

async function generateSalesOrderFromEstimate(conn, estimateId) {
  const [[est]] = await conn.query('SELECT * FROM estimates WHERE id = ?', [estimateId]);

  // The estimate's own header aggregate columns (subtotal/net_of_tax/total_amount/...)
  // are only ever populated if someone visited its Billing step and clicked
  // "Recalculate from Job Orders" -- they can be stale or blank. Recompute fresh from
  // the job order lines being copied, the same way EstimateView's totals footer does,
  // so the order's numbers are always trustworthy regardless of the estimate's own
  // bookkeeping state.
  const [jobOrders] = await conn.query(
    `SELECT jo.*, t.rate AS tax_rate
     FROM estimate_job_orders jo
     LEFT JOIN taxes t ON t.id = jo.tax_code_id
     WHERE jo.estimate_id = ? ORDER BY jo.line_no`,
    [estimateId]
  );
  const subtotal = jobOrders.reduce((s, jo) => s + n(jo.subtotal), 0);
  const discountTotal = jobOrders.reduce((s, jo) => s + n(jo.disc_amount), 0);
  const netOfTax = subtotal - discountTotal;
  const taxTotal = jobOrders.reduce((s, jo) => s + (n(jo.subtotal) - n(jo.disc_amount)) * (n(jo.tax_rate) / 100), 0);
  const totalAmount = netOfTax + taxTotal;

  const [[{ totalCost }]] = await conn.query(
    `SELECT COALESCE(SUM(p.total_cost), 0) AS totalCost
     FROM estimate_job_order_processes p
     JOIN estimate_job_orders jo ON jo.id = p.estimate_job_order_id
     WHERE jo.estimate_id = ?`,
    [estimateId]
  );
  const gpAmount = netOfTax - n(totalCost);
  const gpRate = netOfTax ? (gpAmount / netOfTax) * 100 : 0;

  const computedTotals = {
    subtotal, discount_total: discountTotal, net_of_tax: netOfTax, tax_total: taxTotal, total_amount: totalAmount,
    est_gp_rate: Number(gpRate.toFixed(2)), est_gp_amount: Number(gpAmount.toFixed(2)),
  };
  const soValues = SALES_ORDER_HEADER_FIELDS.map((f) => (
    f === 'estimate_id' ? estimateId : (computedTotals[f] !== undefined ? computedTotals[f] : est[f])
  ));
  const tempNo = `TMP-SO-${Date.now()}`;
  const [result] = await conn.query(
    `INSERT INTO sales_orders (sales_order_no, ${SALES_ORDER_HEADER_FIELDS.join(', ')})
     VALUES (?, ${SALES_ORDER_HEADER_FIELDS.map(() => '?').join(', ')})`,
    [tempNo, ...soValues]
  );
  const salesOrderId = result.insertId;
  await conn.query('UPDATE sales_orders SET sales_order_no = ? WHERE id = ?', [`SO-${60000 + salesOrderId}`, salesOrderId]);

  for (const jo of jobOrders) {
    const lineValues = SALES_ORDER_LINE_FIELDS.map((f) => jo[f]);
    await conn.query(
      `INSERT INTO sales_order_lines (sales_order_id, line_no, estimate_job_order_id, ${SALES_ORDER_LINE_FIELDS.join(', ')})
       VALUES (?, ?, ?, ${SALES_ORDER_LINE_FIELDS.map(() => '?').join(', ')})`,
      [salesOrderId, jo.line_no, jo.id, ...lineValues]
    );
  }

  await conn.query('UPDATE estimates SET sales_order_id = ? WHERE id = ?', [salesOrderId, estimateId]);
  return salesOrderId;
}

function pick(body, fields) {
  return fields.map((f) => (body[f] === undefined ? null : body[f]));
}

async function logAudit(conn, { estimateId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('Estimate', ?, ?, ?, ?, ?, ?)`,
    [estimateId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// MySQL returns BOOLEAN columns as 0/1, but callers often send back JS true/false for the
// same value (e.g. a checkbox round-tripped through the frontend) -- normalize both sides
// so that isn't misread as a change on every save.
function normalizeForDiff(v) {
  if (v === true || v === 1 || v === '1') return '1';
  if (v === false || v === 0 || v === '0') return '0';
  return String(v);
}

async function logFieldDiffs(conn, { estimateId, userId, fields, oldRow, newValues, prefix }) {
  for (const f of fields) {
    const oldVal = oldRow[f];
    const newVal = newValues[f];
    const oldStr = oldVal === null || oldVal === undefined ? null : String(oldVal);
    const newStr = newVal === null || newVal === undefined ? null : String(newVal);
    if (oldStr === newStr) continue;
    if (oldStr !== null && newStr !== null && normalizeForDiff(oldVal) === normalizeForDiff(newVal)) continue;
    await logAudit(conn, {
      estimateId, userId, eventType: 'Updated',
      fieldName: prefix ? `${prefix}.${f}` : f,
      oldValue: oldStr, newValue: newStr,
    });
  }
}

// --- Estimate header ---------------------------------------------------

const STATUS_VALUES = ['pending_supervisor_approval', 'pending_customer_approval', 'approved', 'cancelled', 'disapproved'];

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const {
      status, search, sales_rep_id: salesRepId, office_location_id: officeLocationId, as_of: asOf,
      customer_id: customerId, page = '1', limit = '10',
    } = req.query;

    // Filters other than status (used both for the list itself and for the tab
    // counts, so counts reflect the search/sales-rep/location/date filters currently
    // applied but still show how many rows fall in EACH status).
    const commonWhere = [];
    const commonParams = [];
    if (salesRepId) { commonWhere.push('e.sales_rep_id = ?'); commonParams.push(salesRepId); }
    if (officeLocationId) { commonWhere.push('e.office_location_id = ?'); commonParams.push(officeLocationId); }
    if (asOf) { commonWhere.push('e.date_created <= ?'); commonParams.push(asOf); }
    if (customerId) { commonWhere.push('e.customer_id = ?'); commonParams.push(customerId); }
    if (search) {
      commonWhere.push('(e.estimate_no LIKE ? OR c.name LIKE ? OR e.contract_description LIKE ?)');
      commonParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    // Account Officers only ever see their own estimates; Supervisors see their own plus
    // their direct reports' -- everyone else (System Admin, non-sales roles) is unrestricted.
    const scope = await getSalesRepEmployeeScope(req.user.id);
    if (scope) { commonWhere.push('e.sales_rep_id IN (?)'); commonParams.push(scope); }

    const where = [...commonWhere];
    const params = [...commonParams];
    if (status && STATUS_VALUES.includes(status)) { where.push('e.status = ?'); params.push(status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const commonWhereSql = commonWhere.length ? `WHERE ${commonWhere.join(' AND ')}` : '';

    const baseFrom = `FROM estimates e
       LEFT JOIN customers c ON c.id = e.customer_id
       LEFT JOIN employees sr ON sr.id = e.sales_rep_id
       LEFT JOIN employees pb ON pb.id = e.prepared_by_id
       LEFT JOIN locations loc ON loc.id = e.office_location_id`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${whereSql}`, params);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.query(
      `SELECT e.*, c.name AS customer_name, CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(pb.first_name, ' ', pb.last_name) AS prepared_by_name, loc.location_name
       ${baseFrom} ${whereSql}
       ORDER BY e.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const [countRows] = await pool.query(
      `SELECT e.status, COUNT(*) AS count ${baseFrom} ${commonWhereSql} GROUP BY e.status`,
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
    const [[estimate]] = await pool.query(
      `SELECT e.*, c.name AS customer_name, cc.contact_name,
              sd.name AS sales_division_name, loc.location_name AS office_location_name,
              bp.po_number AS blanket_po_no, so.sales_order_no,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(pb.first_name, ' ', pb.last_name) AS prepared_by_name,
              CONCAT(ap.first_name, ' ', ap.last_name) AS approved_by_name
       FROM estimates e
       LEFT JOIN customers c ON c.id = e.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = e.contact_person_id
       LEFT JOIN sales_divisions sd ON sd.id = e.sales_division_id
       LEFT JOIN locations loc ON loc.id = e.office_location_id
       LEFT JOIN blanket_pos bp ON bp.id = e.blanket_po_id
       LEFT JOIN employees sr ON sr.id = e.sales_rep_id
       LEFT JOIN employees pb ON pb.id = e.prepared_by_id
       LEFT JOIN employees ap ON ap.id = e.approved_by_id
       LEFT JOIN sales_orders so ON so.id = e.sales_order_id
       WHERE e.id = ?`,
      [req.params.id]
    );
    if (!estimate) return res.status(404).json({ error: 'Not found' });
    // Defense in depth -- a scoped user (Account Officer/Supervisor) can't view someone
    // else's estimate just by guessing/pasting its URL, even though the list already
    // filters it out.
    const scope = await getSalesRepEmployeeScope(req.user.id);
    if (scope && !scope.includes(estimate.sales_rep_id)) return res.status(404).json({ error: 'Not found' });

    const [shippingAddresses] = await pool.query('SELECT * FROM estimate_shipping_addresses WHERE estimate_id = ? ORDER BY id', [req.params.id]);
    const [jobOrders] = await pool.query(
      `SELECT jo.*, jt.display_name AS job_type_name, loc.location_name AS job_location_name, t.code AS tax_code, t.rate AS tax_rate
       FROM estimate_job_orders jo
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN taxes t ON t.id = jo.tax_code_id
       WHERE jo.estimate_id = ? ORDER BY jo.line_no`,
      [req.params.id]
    );
    for (const jo of jobOrders) {
      const [processes] = await pool.query(
        `SELECT p.*, pr.process_name, i.display_name AS item_name
         FROM estimate_job_order_processes p
         LEFT JOIN processes pr ON pr.id = p.process_id
         LEFT JOIN inventories i ON i.id = p.item_id
         WHERE p.estimate_job_order_id = ? ORDER BY p.line_no`,
        [jo.id]
      );
      jo.processes = processes;
    }

    res.json({ ...estimate, shippingAddresses, jobOrders });
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
       WHERE a.auditable_type = 'Estimate' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const values = pick(req.body, HEADER_FIELDS);
    const tempNo = `TMP-${Date.now()}`;
    const [result] = await conn.query(
      `INSERT INTO estimates (estimate_no, ${HEADER_FIELDS.join(', ')}) VALUES (?, ${HEADER_FIELDS.map(() => '?').join(', ')})`,
      [req.body.estimate_no || tempNo, ...values]
    );
    const estimateId = result.insertId;
    if (!req.body.estimate_no) {
      await conn.query('UPDATE estimates SET estimate_no = ? WHERE id = ?', [`EST-${100000 + estimateId}`, estimateId]);
    }
    await logAudit(conn, { estimateId, userId: req.user.id, eventType: 'Created' });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimates WHERE id = ?', [estimateId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Estimate number already in use' });
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[oldRow]] = await conn.query('SELECT * FROM estimates WHERE id = ?', [req.params.id]);
    if (!oldRow) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    const values = pick(req.body, HEADER_FIELDS);
    await conn.query(
      `UPDATE estimates SET ${HEADER_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.id]
    );
    const newValues = {};
    HEADER_FIELDS.forEach((f, i) => { newValues[f] = values[i]; });
    await logFieldDiffs(conn, { estimateId: req.params.id, userId: req.user.id, fields: HEADER_FIELDS, oldRow, newValues });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimates WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Clones an estimate's header, job orders, and process lines into a brand-new draft
// estimate (fresh estimate_no, today's date, status reset to the start of the
// approval flow) -- mirrors the real system's "Replicate" action for reusing a past
// estimate as the starting point for a new one instead of re-keying everything.
router.post('/:id/replicate', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[source]] = await conn.query('SELECT * FROM estimates WHERE id = ?', [req.params.id]);
    if (!source) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    const headerValues = HEADER_FIELDS.map((f) => {
      if (f === 'date_created') return new Date().toISOString().slice(0, 10);
      if (f === 'status') return 'pending_supervisor_approval';
      return source[f];
    });
    const tempNo = `TMP-${Date.now()}`;
    const [result] = await conn.query(
      `INSERT INTO estimates (estimate_no, ${HEADER_FIELDS.join(', ')}) VALUES (?, ${HEADER_FIELDS.map(() => '?').join(', ')})`,
      [tempNo, ...headerValues]
    );
    const newEstimateId = result.insertId;
    await conn.query('UPDATE estimates SET estimate_no = ? WHERE id = ?', [`EST-${100000 + newEstimateId}`, newEstimateId]);

    const [jobOrders] = await conn.query('SELECT * FROM estimate_job_orders WHERE estimate_id = ? ORDER BY line_no', [req.params.id]);
    for (const jo of jobOrders) {
      const joValues = JOB_ORDER_FIELDS.map((f) => jo[f]);
      const [joResult] = await conn.query(
        `INSERT INTO estimate_job_orders (estimate_id, line_no, ${JOB_ORDER_FIELDS.join(', ')})
         VALUES (?, ?, ${JOB_ORDER_FIELDS.map(() => '?').join(', ')})`,
        [newEstimateId, jo.line_no, ...joValues]
      );
      const [processes] = await conn.query('SELECT * FROM estimate_job_order_processes WHERE estimate_job_order_id = ? ORDER BY line_no', [jo.id]);
      for (const proc of processes) {
        const procValues = PROCESS_FIELDS.map((f) => proc[f]);
        await conn.query(
          `INSERT INTO estimate_job_order_processes (estimate_job_order_id, line_no, ${PROCESS_FIELDS.join(', ')})
           VALUES (?, ?, ${PROCESS_FIELDS.map(() => '?').join(', ')})`,
          [joResult.insertId, proc.line_no, ...procValues]
        );
      }
    }

    await logAudit(conn, {
      estimateId: newEstimateId, userId: req.user.id, eventType: 'Created',
      fieldName: 'replicated_from', newValue: source.estimate_no,
    });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimates WHERE id = ?', [newEstimateId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Dedicated status-only update for the Approve/Disapprove actions on the read-only
// view -- a plain field update rather than routing through the full-header PUT, which
// expects every HEADER_FIELDS value re-sent in the exact shape the DB column wants
// (e.g. date_created as a bare date, not the ISO datetime GET returns it as).
router.put('/:id/status', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[oldRow]] = await conn.query('SELECT status, sales_order_id FROM estimates WHERE id = ?', [req.params.id]);
    if (!oldRow) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    if (!STATUS_VALUES.includes(req.body.status)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Invalid status' });
    }
    // Approving out of the initial "pending supervisor approval" stage requires the
    // Can Approve Sales Estimate flag from the user's Account Type settings -- checked
    // fresh against the DB rather than trusting the JWT, since that flag can change
    // after the token was issued.
    if (oldRow.status === 'pending_supervisor_approval' && req.body.status === 'pending_customer_approval') {
      const [[approver]] = await conn.query('SELECT can_approve_sales_estimate FROM users WHERE id = ?', [req.user.id]);
      if (!approver?.can_approve_sales_estimate) {
        await conn.rollback();
        return res.status(403).json({ error: 'You are not allowed to approve estimates' });
      }
    }
    // Approved By is no longer a manually-picked field (nobody knows who'll approve an
    // estimate at creation time) -- it's set here, to whoever actually performs the
    // approval, once the estimate reaches its final "Approved" status.
    if (req.body.status === 'approved') {
      const [[approvingUser]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
      if (approvingUser?.employee_id) {
        await conn.query('UPDATE estimates SET approved_by_id = ? WHERE id = ?', [approvingUser.employee_id, req.params.id]);
      }
    }
    await conn.query('UPDATE estimates SET status = ?, updated_at = NOW() WHERE id = ?', [req.body.status, req.params.id]);
    await logAudit(conn, {
      estimateId: req.params.id, userId: req.user.id, eventType: 'Updated',
      fieldName: 'status', oldValue: oldRow.status, newValue: req.body.status,
    });
    // Reaching the final "Approved" status is what generates the Sales Order in the
    // real system -- copied as a snapshot (not a live reference) since the estimate can
    // still be edited/replicated afterward independently of the order already placed.
    if (req.body.status === 'approved' && !oldRow.sales_order_id) {
      const salesOrderId = await generateSalesOrderFromEstimate(conn, req.params.id);
      await logAudit(conn, {
        estimateId: req.params.id, userId: req.user.id, eventType: 'Updated',
        fieldName: 'sales_order_id', oldValue: null, newValue: String(salesOrderId),
      });
    }
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimates WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [jobOrders] = await conn.query('SELECT id FROM estimate_job_orders WHERE estimate_id = ?', [req.params.id]);
    for (const jo of jobOrders) {
      await conn.query('DELETE FROM estimate_job_order_processes WHERE estimate_job_order_id = ?', [jo.id]);
    }
    await conn.query('DELETE FROM estimate_job_orders WHERE estimate_id = ?', [req.params.id]);
    await conn.query('DELETE FROM estimate_shipping_addresses WHERE estimate_id = ?', [req.params.id]);
    await conn.query('DELETE FROM estimates WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// --- Shipping addresses --------------------------------------------------

router.post('/:id/shipping-addresses', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      'INSERT INTO estimate_shipping_addresses (estimate_id, address) VALUES (?, ?)',
      [req.params.id, req.body.address]
    );
    const [[row]] = await pool.query('SELECT * FROM estimate_shipping_addresses WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/shipping-addresses/:addressId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM estimate_shipping_addresses WHERE id = ? AND estimate_id = ?', [req.params.addressId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// --- Job orders ------------------------------------------------------------

router.post('/:id/job-orders', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[{ nextLine }]] = await conn.query(
      'SELECT COALESCE(MAX(line_no), 0) + 1 AS nextLine FROM estimate_job_orders WHERE estimate_id = ?',
      [req.params.id]
    );
    const values = pick(req.body, JOB_ORDER_FIELDS);
    const [result] = await conn.query(
      `INSERT INTO estimate_job_orders (estimate_id, line_no, ${JOB_ORDER_FIELDS.join(', ')})
       VALUES (?, ?, ${JOB_ORDER_FIELDS.map(() => '?').join(', ')})`,
      [req.params.id, nextLine, ...values]
    );
    await logAudit(conn, { estimateId: req.params.id, userId: req.user.id, eventType: 'Created', fieldName: `job_order[${nextLine}]` });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimate_job_orders WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/job-orders/:joId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[oldRow]] = await conn.query('SELECT * FROM estimate_job_orders WHERE id = ? AND estimate_id = ?', [req.params.joId, req.params.id]);
    if (!oldRow) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    const values = pick(req.body, JOB_ORDER_FIELDS);
    await conn.query(
      `UPDATE estimate_job_orders SET ${JOB_ORDER_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.joId]
    );
    const newValues = {};
    JOB_ORDER_FIELDS.forEach((f, i) => { newValues[f] = values[i]; });
    await logFieldDiffs(conn, {
      estimateId: req.params.id, userId: req.user.id, fields: JOB_ORDER_FIELDS, oldRow, newValues,
      prefix: `job_order[${oldRow.line_no}]`,
    });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimate_job_orders WHERE id = ?', [req.params.joId]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id/job-orders/:joId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT * FROM estimate_job_orders WHERE id = ? AND estimate_id = ?', [req.params.joId, req.params.id]);
    if (!jo) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    await conn.query('DELETE FROM estimate_job_order_processes WHERE estimate_job_order_id = ?', [req.params.joId]);
    await conn.query('DELETE FROM estimate_job_orders WHERE id = ?', [req.params.joId]);
    await logAudit(conn, { estimateId: req.params.id, userId: req.user.id, eventType: 'Deleted', fieldName: `job_order[${jo.line_no}]` });
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// --- Job order processes ----------------------------------------------------

router.post('/:id/job-orders/:joId/processes', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT line_no FROM estimate_job_orders WHERE id = ? AND estimate_id = ?', [req.params.joId, req.params.id]);
    if (!jo) {
      await conn.rollback();
      return res.status(404).json({ error: 'Job order not found' });
    }
    const [[{ nextLine }]] = await conn.query(
      'SELECT COALESCE(MAX(line_no), 0) + 1 AS nextLine FROM estimate_job_order_processes WHERE estimate_job_order_id = ?',
      [req.params.joId]
    );
    const values = pick(req.body, PROCESS_FIELDS);
    const [result] = await conn.query(
      `INSERT INTO estimate_job_order_processes (estimate_job_order_id, line_no, ${PROCESS_FIELDS.join(', ')})
       VALUES (?, ?, ${PROCESS_FIELDS.map(() => '?').join(', ')})`,
      [req.params.joId, nextLine, ...values]
    );
    await logAudit(conn, {
      estimateId: req.params.id, userId: req.user.id, eventType: 'Created',
      fieldName: `job_order[${jo.line_no}].process[${nextLine}]`,
    });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimate_job_order_processes WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/job-orders/:joId/processes/:procId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT line_no FROM estimate_job_orders WHERE id = ? AND estimate_id = ?', [req.params.joId, req.params.id]);
    const [[oldRow]] = await conn.query(
      'SELECT * FROM estimate_job_order_processes WHERE id = ? AND estimate_job_order_id = ?',
      [req.params.procId, req.params.joId]
    );
    if (!jo || !oldRow) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    const values = pick(req.body, PROCESS_FIELDS);
    await conn.query(
      `UPDATE estimate_job_order_processes SET ${PROCESS_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.procId]
    );
    const newValues = {};
    PROCESS_FIELDS.forEach((f, i) => { newValues[f] = values[i]; });
    await logFieldDiffs(conn, {
      estimateId: req.params.id, userId: req.user.id, fields: PROCESS_FIELDS, oldRow, newValues,
      prefix: `job_order[${jo.line_no}].process[${oldRow.line_no}]`,
    });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimate_job_order_processes WHERE id = ?', [req.params.procId]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id/job-orders/:joId/processes/:procId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT line_no FROM estimate_job_orders WHERE id = ? AND estimate_id = ?', [req.params.joId, req.params.id]);
    const [[proc]] = await conn.query(
      'SELECT line_no FROM estimate_job_order_processes WHERE id = ? AND estimate_job_order_id = ?',
      [req.params.procId, req.params.joId]
    );
    if (!jo || !proc) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    await conn.query('DELETE FROM estimate_job_order_processes WHERE id = ?', [req.params.procId]);
    await logAudit(conn, {
      estimateId: req.params.id, userId: req.user.id, eventType: 'Deleted',
      fieldName: `job_order[${jo.line_no}].process[${proc.line_no}]`,
    });
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
