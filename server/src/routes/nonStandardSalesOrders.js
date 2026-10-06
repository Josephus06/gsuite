const express = require('express');
const pool = require('../db');
const { assignDocNo } = require('../lib/docNumber');
const { requireAuth, requirePermission, userCan, isSystemAdmin } = require('../middleware/auth');
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');
const { DESIGN_QUEUE_STATUS } = require('../lib/designSupervisorVisibility');
const { notifyDesignSupervisors } = require('../lib/designNotifications');

const router = express.Router();
// Non-Standard Sales Order (NSSO-<TYPE>-####): a sales-order-like document raised outside the
// Estimate -> SO path, in four types that each nest to a different source record:
//   rma -> a Sales Order with a Completed job order; rma_installation -> any Sales Order;
//   sample -> an approved Estimate; internal -> nothing.
// This build focuses on the RMA type end to end; the others share the same tables/flow.
const ROUTE = '/non-standard-sales-orders';

// Filling in an NSSO's header and job lines is part of CREATING it, the way adding job items is
// part of creating an Estimate. Gating it on can_edit alone meant Sales, who hold can_add but not
// can_edit, could raise an NSSO and then have every save after step 1 refused -- NSSO-INT-41 and
// -51 were left with no job lines that way. So: can_edit changes any NSSO, and whoever raised one
// may keep working on it until it is approved. Approval is the line after which changes need Edit.
function requireEditOrOwnDraft(req, res, next) {
  (async () => {
    if (await userCan(req.user.id, ROUTE, 'can_edit')) return next();
    const [[n]] = await pool.query(
      'SELECT created_by_user_id, status FROM non_standard_sales_orders WHERE id = ?',
      [req.params.id]
    );
    if (n && Number(n.created_by_user_id) === Number(req.user.id) && n.status === 'pending_approval'
        && await userCan(req.user.id, ROUTE, 'can_add')) return next();
    res.status(403).json({ error: 'You do not have permission to perform this action' });
  })().catch(next);
}

const TYPE_ABBR = { rma: 'RMA', rma_installation: 'INST', sample: 'SAM', internal: 'INT' };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const decOrNull = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const round2 = (n) => Number((num(n)).toFixed(2));
const trunc = (v, n) => (v == null ? null : String(v).slice(0, n));

async function logAudit(conn, { id, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('NonStandardSalesOrder', ?, ?, ?, ?, ?, ?)`,
    [id, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

async function recomputeTotals(conn, nssoId) {
  const [[t]] = await conn.query(
    `SELECT COALESCE(SUM(net_of_tax),0) net, COALESCE(SUM(tax_amount),0) tax, COALESCE(SUM(gross_amount),0) gross,
            COALESCE(SUM(subtotal),0) sub, COALESCE(SUM(allowance_amount),0) allowance, COALESCE(SUM(sample_amount),0) sample
     FROM non_standard_sales_order_lines WHERE nsso_id = ?`,
    [nssoId]
  );
  await conn.query(
    'UPDATE non_standard_sales_orders SET subtotal=?, net_of_tax=?, tax_total=?, total_amount=?, total_allowance=?, total_sample=?, updated_at=NOW() WHERE id=?',
    [round2(t.sub), round2(t.net), round2(t.tax), round2(t.gross), round2(t.allowance), round2(t.sample), nssoId]
  );
}

// The logged-in user's default Sales Rep / Sales Division / Office Location for the create form.
// Sales rep = the user's own employee; office location + department come from their default
// user_branches row; the department is mapped to the matching sales_division by name.
async function defaultsForUser(userId, divisions) {
  const [[row]] = await pool.query(
    `SELECT u.employee_id AS sales_rep_id, ub.location_id AS office_location_id, d.name AS dept_name
     FROM users u
     LEFT JOIN user_branches ub ON ub.user_id = u.id AND ub.is_default = TRUE
     LEFT JOIN departments d ON d.id = ub.department_id
     WHERE u.id = ?`,
    [userId]
  );
  if (!row) return { sales_rep_id: null, sales_division_id: null, office_location_id: null };
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let salesDivisionId = null;
  if (row.dept_name) {
    const dn = norm(row.dept_name);
    const exact = divisions.find((x) => norm(x.name) === dn);
    const prefix = divisions.filter((x) => dn.startsWith(norm(x.name))).sort((a, b) => norm(b.name).length - norm(a.name).length)[0];
    salesDivisionId = (exact || prefix)?.id || null;
  }
  let officeLocationId = row.office_location_id;
  if (!officeLocationId) { const [[ho]] = await pool.query("SELECT id FROM locations WHERE location_name = 'Head Office' LIMIT 1"); officeLocationId = ho?.id || null; }
  return { sales_rep_id: row.sales_rep_id || null, sales_division_id: salesDivisionId, office_location_id: officeLocationId };
}

// Lookups for the create wizard.
router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [customers] = await pool.query('SELECT id, name, company_name, customer_code, tin FROM customers ORDER BY name');
    const [employees] = await pool.query("SELECT id, first_name, last_name, employee_code FROM employees WHERE is_active = TRUE ORDER BY first_name, last_name");
    const [divisions] = await pool.query('SELECT id, name FROM sales_divisions ORDER BY name');
    const [locations] = await pool.query('SELECT id, location_name, location_code FROM locations ORDER BY location_name');
    const [jobTypes] = await pool.query('SELECT id, display_name, item_code FROM job_types WHERE is_active = TRUE ORDER BY display_name');
    const [reasons] = await pool.query('SELECT id, name, reason_type FROM reasons WHERE is_active = TRUE ORDER BY name');
    const [processes] = await pool.query('SELECT id, process_code, process_name FROM processes WHERE is_active = TRUE ORDER BY process_name');
    const [items] = await pool.query('SELECT id, item_code, display_name FROM inventories WHERE is_active = TRUE ORDER BY display_name');
    const defaults = await defaultsForUser(req.user.id, divisions);
    res.json({ customers, employees, divisions, locations, jobTypes, reasons, processes, items, defaults });
  } catch (err) { next(err); }
});

// Sales Orders this NSSO can nest to. For rma, only SOs that have a Completed job order; for
// rma_installation, any SO. Returns a compact picker list.
router.get('/nestable-sales-orders', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const type = String(req.query.type || 'rma');
    const search = req.query.search ? `%${req.query.search}%` : null;
    const where = [];
    const params = [];
    if (type === 'rma') {
      where.push("EXISTS (SELECT 1 FROM job_orders jo WHERE jo.sales_order_id = so.id AND jo.production_stage IN ('completed','invoiced'))");
    }
    if (search) { where.push('(so.sales_order_no LIKE ? OR c.name LIKE ?)'); params.push(search, search); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const cols = `SELECT so.id, so.sales_order_no, so.date_created, so.status, so.total_amount,
              c.name AS customer_name, so.customer_id
       FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id`;
    const [rows] = await pool.query(`${cols} ${whereSql} ORDER BY so.id DESC LIMIT 300`, params);
    // The SO an NSSO already nests to stays in the list whatever the search, so the picker can name it.
    const includeId = Number(req.query.include_id) || null;
    if (includeId && !rows.some((r) => r.id === includeId)) {
      const [[cur]] = await pool.query(`${cols} WHERE so.id = ?`, [includeId]);
      if (cur) rows.push(cur);
    }
    res.json(rows);
  } catch (err) { next(err); }
});

// The customer's contacts, for the Contact Name picker -- and adding one, as the estimate form does
// (asked 2026-10-06). A new contact is saved to the customer in Master Lists, not just on this NSSO.
router.get('/customer-contacts/:customerId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, contact_name, title, email, phone FROM customer_contacts WHERE customer_id = ? ORDER BY is_primary DESC, contact_name',
      [req.params.customerId]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/contacts', requireAuth, async (req, res, next) => {
  try {
    if (!(await userCan(req.user.id, ROUTE, 'can_add')) && !(await userCan(req.user.id, ROUTE, 'can_edit'))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { customer_id: customerId, contact_name: contactName, title, email, phone } = req.body;
    if (!customerId) return res.status(400).json({ error: 'Select a customer first.' });
    if (!contactName || !String(contactName).trim()) return res.status(400).json({ error: 'Contact name is required.' });
    const [[customer]] = await pool.query('SELECT id FROM customers WHERE id = ?', [customerId]);
    if (!customer) return res.status(400).json({ error: 'Invalid customer.' });
    const [result] = await pool.query(
      `INSERT INTO customer_contacts (customer_id, contact_name, title, email, phone, is_primary)
       VALUES (?, ?, ?, ?, ?, FALSE)`,
      [customerId, String(contactName).trim(), title?.trim() || null, email?.trim() || null, phone?.trim() || null]);
    const [[row]] = await pool.query('SELECT id, contact_name, title, email, phone FROM customer_contacts WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// Billing block for the wizard's Billing / Review steps: the customer's credit terms + address.
router.get('/customer-billing/:customerId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[c]] = await pool.query(
      `SELECT c.id, c.name, c.tin, c.credit_limit, pt.term_name AS credit_term,
              (SELECT address_line FROM customer_addresses a WHERE a.customer_id = c.id ORDER BY a.is_default DESC, a.id LIMIT 1) AS address,
              (SELECT phone FROM customer_contacts cc WHERE cc.customer_id = c.id ORDER BY cc.is_primary DESC, cc.id LIMIT 1) AS contact_number
       FROM customers c LEFT JOIN payment_terms pt ON pt.id = c.payment_term_id WHERE c.id = ?`,
      [req.params.customerId]
    );
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    res.json({
      customer_name: c.name, credit_term: c.credit_term || null, credit_limit: c.credit_limit,
      credit_balance: 0, bill_to: null, address: c.address || null, contact_number: c.contact_number || null,
    });
  } catch (err) { next(err); }
});

// Estimates a Sample NSSO can nest to -- all of them, regardless of approval status.
router.get('/nestable-estimates', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const search = req.query.search ? `%${req.query.search}%` : null;
    const where = [];
    const params = [];
    if (search) { where.push('(e.estimate_no LIKE ? OR c.name LIKE ?)'); params.push(search, search); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      // No small LIMIT: the picker searches the loaded list client-side (like the customers picker),
      // so all estimates must be present for search to reach older ones. High cap as a safety net.
      `SELECT e.id, e.estimate_no, e.date_created, e.status, e.total_amount, e.customer_id, c.name AS customer_name
       FROM estimates e LEFT JOIN customers c ON c.id = e.customer_id
       ${whereSql} ORDER BY e.id DESC LIMIT 20000`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// The job-order (job-type) lines of a nested Estimate -- for Sample, the ones you can sample.
router.get('/source-estimate-jobs/:estimateId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT ejo.id, ejo.line_no, ejo.job_type_id, jt.display_name AS job_type_name, ejo.job_location_id,
              ejo.description, ejo.quantity, ejo.units, ejo.price_per_unit, ejo.subtotal, ejo.disc_percent, ejo.disc_amount,
              ejo.net_of_tax, ejo.tax_code_id, ejo.tax_amount, ejo.gross_amount, ejo.length, ejo.width, ejo.height, ejo.uom, ejo.delivery_date
       FROM estimate_job_orders ejo LEFT JOIN job_types jt ON jt.id = ejo.job_type_id
       WHERE ejo.estimate_id = ? ORDER BY ejo.line_no`,
      [req.params.estimateId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Replace the NSSO's lines from selected Estimate job orders (Sample). Copies pricing + sizes; the
// sample amount / allowance default to the estimate line's net (a full-value sample) -- editable
// later. Each line links back to its source estimate job order.
router.post('/:id/lines/from-estimate', requireAuth, requireEditOrOwnDraft, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const ids = Array.isArray(req.body?.estimate_job_order_ids) ? req.body.estimate_job_order_ids : [];
    await conn.beginTransaction();
    await conn.query('DELETE FROM non_standard_sales_order_lines WHERE nsso_id = ?', [req.params.id]);
    let lineNo = 0;
    for (const ejoId of ids) {
      const [[e]] = await conn.query('SELECT * FROM estimate_job_orders WHERE id = ?', [ejoId]);
      if (!e) continue;
      lineNo += 1;
      await conn.query(
        `INSERT INTO non_standard_sales_order_lines
           (nsso_id, line_no, job_type_id, job_location_id, description, quantity, units, price_per_unit, subtotal,
            disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, gross_amount, length, width, height, uom,
            delivery_date, sample_qty, sample_amount, allowance_amount, source_estimate_job_order_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id, lineNo, e.job_type_id, e.job_location_id, trunc(e.description, 500), num(e.quantity), trunc(e.units, 50),
         num(e.price_per_unit), round2(e.subtotal), num(e.disc_percent), round2(e.disc_amount), round2(e.net_of_tax),
         e.tax_code_id, round2(e.tax_amount), round2(e.gross_amount), decOrNull(e.length), decOrNull(e.width), decOrNull(e.height),
         trunc(e.uom, 50), e.delivery_date || null, num(e.quantity), round2(e.net_of_tax), 0, e.id]
      );
    }
    await recomputeTotals(conn, req.params.id);
    await conn.commit();
    const [lines] = await pool.query(
      `SELECT l.*, jt.display_name AS job_type_name, jl.location_name AS job_location_name
       FROM non_standard_sales_order_lines l
       LEFT JOIN job_types jt ON jt.id = l.job_type_id
       LEFT JOIN locations jl ON jl.id = l.job_location_id
       WHERE l.nsso_id = ? ORDER BY l.line_no`,
      [req.params.id]
    );
    res.json(lines);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// The job orders of a (nested) Sales Order -- for RMA, the Completed ones you can redo.
router.get('/source-job-orders/:salesOrderId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.description, jo.quantity, jo.units, jo.production_stage,
              jo.job_type_id, jt.display_name AS job_type_name, jo.job_location_id
       FROM job_orders jo LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       WHERE jo.sales_order_id = ? ORDER BY jo.job_order_no`,
      [req.params.salesOrderId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status, type } = req.query;
    const where = []; const params = [];
    if (status) { where.push('n.status = ?'); params.push(status); }
    if (type) { where.push('n.type = ?'); params.push(type); }
    // An Account Officer sees only their own non-standard sales orders; a Supervisor sees theirs plus their
    // reports'. Same rule Estimates and Sales Orders already apply -- see lib/salesVisibility.js,
    // which returns null (and so changes nothing) for every account that is neither.
    const salesScope = await getSalesRepEmployeeScope(req.user.id);
    if (salesScope) { where.push('n.sales_rep_id IN (?)'); params.push(salesScope); }
    if (search) { where.push('(n.nsso_no LIKE ? OR c.name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT n.id, n.nsso_no, n.type, n.date_created, n.total_amount, n.status, n.memo,
              c.name AS customer_name, n.customer_id, loc.location_name AS office_location_name,
              CONCAT(e.first_name, ' ', e.last_name) AS sales_rep_name,
              so.sales_order_no AS nested_sales_order_no
       FROM non_standard_sales_orders n
       LEFT JOIN customers c ON c.id = n.customer_id
       LEFT JOIN locations loc ON loc.id = n.office_location_id
       LEFT JOIN employees e ON e.id = n.sales_rep_id
       LEFT JOIN sales_orders so ON so.id = n.nested_sales_order_id
       ${whereSql} ORDER BY n.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[n]] = await pool.query(
      `SELECT n.*, c.name AS customer_name, c.tin AS customer_tin, cp.contact_name AS contact_person_name,
              d.name AS sales_division_name, loc.location_name AS office_location_name,
              CONCAT(e.first_name, ' ', e.last_name) AS sales_rep_name,
              CONCAT(pb.first_name, ' ', pb.last_name) AS prepared_by_name,
              CONCAT(ab.first_name, ' ', ab.last_name) AS approved_by_name,
              so.sales_order_no AS nested_sales_order_no, est.estimate_no AS nested_estimate_no
       FROM non_standard_sales_orders n
       LEFT JOIN customers c ON c.id = n.customer_id
       LEFT JOIN customer_contacts cp ON cp.id = n.contact_person_id
       LEFT JOIN sales_divisions d ON d.id = n.sales_division_id
       LEFT JOIN locations loc ON loc.id = n.office_location_id
       LEFT JOIN employees e ON e.id = n.sales_rep_id
       LEFT JOIN employees pb ON pb.id = n.prepared_by_id
       LEFT JOIN employees ab ON ab.id = n.approved_by_id
       LEFT JOIN sales_orders so ON so.id = n.nested_sales_order_id
       LEFT JOIN estimates est ON est.id = n.nested_estimate_id
       WHERE n.id = ?`,
      [req.params.id]
    );
    if (!n) return res.status(404).json({ error: 'Not found' });
    // Defence in depth for the list filter above: hiding a document from the list while still
    // serving it to anyone who types its id is not a restriction. See lib/salesVisibility.js.
    const salesScope = await getSalesRepEmployeeScope(req.user.id);
    if (salesScope && !salesScope.includes(n.sales_rep_id)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const [lines] = await pool.query(
      `SELECT l.*, jt.display_name AS job_type_name, jl.location_name AS job_location_name,
              sjo.job_order_no AS source_job_order_no, cjo.job_order_no AS created_job_order_no,
              -- The line's Job Order progress, which decides whether Item Delivery and Bill apply --
              -- the same quantities a Sales Order line is judged on.
              cjo.quantity_built, cjo.quantity_inspected, cjo.quantity_delivered, cjo.quantity_invoiced
       FROM non_standard_sales_order_lines l
       LEFT JOIN job_types jt ON jt.id = l.job_type_id
       LEFT JOIN locations jl ON jl.id = l.job_location_id
       LEFT JOIN job_orders sjo ON sjo.id = l.source_job_order_id
       LEFT JOIN job_orders cjo ON cjo.id = l.created_job_order_id
       WHERE l.nsso_id = ? ORDER BY l.line_no`,
      [req.params.id]
    );
    // Billing block (customer credit terms + address) for the banner.
    let billing = null;
    if (n.customer_id) {
      const [[b]] = await pool.query(
        `SELECT pt.term_name AS credit_term, c.credit_limit,
                (SELECT address_line FROM customer_addresses a WHERE a.customer_id = c.id ORDER BY a.is_default DESC, a.id LIMIT 1) AS address,
                (SELECT phone FROM customer_contacts cc WHERE cc.customer_id = c.id ORDER BY cc.is_primary DESC, cc.id LIMIT 1) AS contact_number
         FROM customers c LEFT JOIN payment_terms pt ON pt.id = c.payment_term_id WHERE c.id = ?`,
        [n.customer_id]
      );
      billing = b || null;
    }
    // Related Records: what has been delivered and billed off this NSSO.
    const [deliveries] = await pool.query(
      'SELECT id, delivery_no, date_created, status FROM item_deliveries WHERE nsso_id = ? ORDER BY id DESC', [req.params.id]
    );
    const [invoices] = await pool.query(
      'SELECT id, invoice_no, date_created, gross_amount, status FROM sales_invoices WHERE nsso_id = ? ORDER BY id DESC', [req.params.id]
    );
    res.json({ ...n, lines, billing, deliveries, invoices });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'NonStandardSalesOrder' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

const HEADER_FIELDS = [
  'date_created', 'customer_id', 'contact_person_id', 'contact_email', 'contact_title', 'contact_phone',
  'sales_rep_id', 'sales_division_id', 'office_location_id', 'contract_description', 'memo', 'shipping_address',
  'has_multiple_shipping', 'nested_sales_order_id', 'nested_estimate_id', 'production_lead_time',
  'print_warranty', 'print_warranty_term', 'structure_warranty', 'structure_warranty_term',
  'electrical_warranty', 'electrical_warranty_term', 'prepared_by_id',
];

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const type = String(req.body.type || '');
    if (!TYPE_ABBR[type]) return res.status(400).json({ error: 'Choose a valid NSSO type.' });
    if ((type === 'rma' || type === 'rma_installation') && !req.body.nested_sales_order_id) {
      return res.status(400).json({ error: 'Select the Sales Order this NSSO applies to.' });
    }
    if (type === 'sample' && !req.body.nested_estimate_id) {
      return res.status(400).json({ error: 'Select the Estimate this Sample NSSO applies to.' });
    }

    const cols = ['nsso_no', 'type', 'status', 'created_by_user_id'];
    const vals = ['', type, 'pending_approval', req.user.id];
    for (const f of HEADER_FIELDS) {
      const v = req.body[f];
      if (v === undefined) continue; // let the column default apply (esp. the NOT NULL boolean flags)
      cols.push(f);
      vals.push(v === '' ? null : v);
    }

    await conn.beginTransaction();
    const [r] = await conn.query(`INSERT INTO non_standard_sales_orders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
    const id = r.insertId;
    // Each type continues its own sequence from the migrated source numbers (NSSO-SAM-2435 -> 2436),
    // not NSSO-<TYPE>-<row id>, which jumped to five figures once the source's NSSOs were imported.
    const nssoNo = await assignDocNo(conn, { table: 'non_standard_sales_orders', column: 'nsso_no', prefix: `NSSO-${TYPE_ABBR[type]}-`, id });
    await logAudit(conn, { id, userId: req.user.id, eventType: 'Created', fieldName: 'nsso_no', newValue: nssoNo });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM non_standard_sales_orders WHERE id = ?', [id]);
    res.status(201).json(row);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id', requireAuth, requireEditOrOwnDraft, async (req, res, next) => {
  try {
    const sets = []; const vals = [];
    for (const f of HEADER_FIELDS) {
      if (f in req.body) { sets.push(`${f} = ?`); vals.push(req.body[f] === '' || req.body[f] === undefined ? null : req.body[f]); }
    }
    if (!sets.length) return res.json({ ok: true });
    await pool.query(`UPDATE non_standard_sales_orders SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, [...vals, req.params.id]);
    const [[row]] = await pool.query('SELECT * FROM non_standard_sales_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) { next(err); }
});

// Replace the NSSO's job-order lines from a set of source job orders (RMA: the Completed JOs the
// user chose to redo). Copies job type / description / quantity / units from each JO.
router.post('/:id/lines/from-source', requireAuth, requireEditOrOwnDraft, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const ids = Array.isArray(req.body?.source_job_order_ids) ? req.body.source_job_order_ids : [];
    await conn.beginTransaction();
    await conn.query('DELETE FROM non_standard_sales_order_lines WHERE nsso_id = ?', [req.params.id]);
    let lineNo = 0;
    for (const joId of ids) {
      const [[jo]] = await conn.query('SELECT id, description, quantity, units, job_type_id, job_location_id FROM job_orders WHERE id = ?', [joId]);
      if (!jo) continue;
      lineNo += 1;
      await conn.query(
        `INSERT INTO non_standard_sales_order_lines (nsso_id, line_no, job_type_id, job_location_id, description, quantity, units, source_job_order_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [req.params.id, lineNo, jo.job_type_id, jo.job_location_id, trunc(jo.description, 500), num(jo.quantity), trunc(jo.units, 50), jo.id]
      );
    }
    await recomputeTotals(conn, req.params.id);
    await conn.commit();
    const [lines] = await pool.query(
      `SELECT l.*, jt.display_name AS job_type_name, jl.location_name AS job_location_name, sjo.job_order_no AS source_job_order_no
       FROM non_standard_sales_order_lines l
       LEFT JOIN job_types jt ON jt.id = l.job_type_id
       LEFT JOIN locations jl ON jl.id = l.job_location_id
       LEFT JOIN job_orders sjo ON sjo.id = l.source_job_order_id
       WHERE l.nsso_id = ? ORDER BY l.line_no`,
      [req.params.id]
    );
    res.json(lines);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Replace the NSSO's job-order lines with a manually-entered set (INTERNAL: no nesting -- the user
// picks a Job Type per line up front; processes/items are added later, after approval, via the
// Create-JO modal). source_job_order_id stays NULL and all pricing is 0 -- an internal work order
// carries no revenue.
router.put('/:id/lines', requireAuth, requireEditOrOwnDraft, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const rows = Array.isArray(req.body?.lines) ? req.body.lines : [];
    await conn.beginTransaction();
    await conn.query('DELETE FROM non_standard_sales_order_lines WHERE nsso_id = ?', [req.params.id]);
    let lineNo = 0;
    for (const l of rows) {
      if (!l.job_type_id) continue; // a line needs at least a Job Type
      lineNo += 1;
      await conn.query(
        `INSERT INTO non_standard_sales_order_lines
           (nsso_id, line_no, job_type_id, job_location_id, description, quantity, units, uom, length, width, height, remarks, memo, delivery_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id, lineNo, l.job_type_id, l.job_location_id || null, trunc(l.description, 500), num(l.quantity),
         trunc(l.units, 50), trunc(l.uom, 50), decOrNull(l.length), decOrNull(l.width), decOrNull(l.height),
         trunc(l.remarks, 500), trunc(l.memo, 500), l.delivery_date || null]
      );
    }
    await recomputeTotals(conn, req.params.id);
    await conn.commit();
    const [lines] = await pool.query(
      `SELECT l.*, jt.display_name AS job_type_name, jl.location_name AS job_location_name, sjo.job_order_no AS source_job_order_no
       FROM non_standard_sales_order_lines l
       LEFT JOIN job_types jt ON jt.id = l.job_type_id
       LEFT JOIN locations jl ON jl.id = l.job_location_id
       LEFT JOIN job_orders sjo ON sjo.id = l.source_job_order_id
       WHERE l.nsso_id = ? ORDER BY l.line_no`,
      [req.params.id]
    );
    res.json(lines);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// One line's Description and Job Location (asked 2026-10-03), for the RMA / RMA-Installation / Sample
// lines, which are copied from a source JO or estimate line and were otherwise read-only. If the
// line's Job Order already exists it carries the same two fields, so it is updated with it -- the
// JO's Job Location is what decides which production warehouse sees it.
// A line's Qty once its Job Order exists (asked 2026-10-06: "still can't edit the sample qty"). The
// JO carries the quantity, so it moves with the line -- but only while nothing has been built,
// inspected or delivered on it: after that the floor's figures are counted against the old quantity.
// Returns a refusal message, or null when the JO (if any) has been updated in step.
async function moveJobOrderQty(conn, line, qty) {
  if (!line.created_job_order_id) return null;
  const [[jo]] = await conn.query(
    'SELECT quantity_built, quantity_inspected, quantity_delivered, status FROM job_orders WHERE id = ?', [line.created_job_order_id]);
  if (!jo) return null;
  if (num(jo.quantity_built) > 0 || num(jo.quantity_inspected) > 0 || num(jo.quantity_delivered) > 0) {
    return 'This line\'s Job Order has already been built on, so its quantity can no longer change here.';
  }
  await conn.query('UPDATE job_orders SET quantity = ?, updated_at = NOW() WHERE id = ?', [qty, line.created_job_order_id]);
  return null;
}

router.put('/:id/lines/:lineId/details', requireAuth, requireEditOrOwnDraft, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[line]] = await conn.query('SELECT * FROM non_standard_sales_order_lines WHERE id = ? AND nsso_id = ?', [req.params.lineId, req.params.id]);
    if (!line) return res.status(404).json({ error: 'Line not found' });
    const [[n]] = await conn.query('SELECT status FROM non_standard_sales_orders WHERE id = ?', [req.params.id]);
    if (n?.status === 'cancelled') return res.status(409).json({ error: 'This NSSO is cancelled.' });
    const b = req.body || {};
    const description = b.description !== undefined ? trunc(String(b.description).trim(), 500) : line.description;
    let jobLocationId = line.job_location_id;
    if (b.job_location_id !== undefined) {
      jobLocationId = Number(b.job_location_id) || null;
      if (jobLocationId) {
        const [[loc]] = await conn.query('SELECT id FROM locations WHERE id = ?', [jobLocationId]);
        if (!loc) return res.status(400).json({ error: 'Choose a valid Job Location.' });
      }
    }
    // Qty (asked 2026-10-06) -- for an RMA / RMA-Installation / Internal line; a Sample line's goes
    // through /sample, which also carries its amount. Like that one it is locked once the line's Job
    // Order exists (the JO carries the quantity). The line is re-priced at its own Price/Unit and
    // discount %, at its own tax rate, so the NSSO total follows.
    let qty = num(line.quantity);
    if (b.quantity !== undefined) {
      qty = Number(b.quantity);
      if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Qty must be more than zero.' });
    }
    const qtyChanged = Math.abs(qty - num(line.quantity)) > 1e-9;
    await conn.beginTransaction();
    await conn.query('UPDATE non_standard_sales_order_lines SET description = ?, job_location_id = ? WHERE id = ?', [description, jobLocationId, line.id]);
    if (qtyChanged) {
      const refusal = await moveJobOrderQty(conn, line, qty);
      if (refusal) { await conn.rollback(); return res.status(409).json({ error: refusal }); }
      const rate = num(line.net_of_tax) > 0 ? (num(line.tax_amount) / num(line.net_of_tax)) * 100 : 0;
      const subtotal = round2(num(line.price_per_unit) * qty);
      const discAmount = round2(subtotal * num(line.disc_percent) / 100);
      const net = round2(subtotal - discAmount);
      const tax = round2(net * rate / 100);
      await conn.query(
        `UPDATE non_standard_sales_order_lines
            SET quantity = ?, subtotal = ?, disc_amount = ?, net_of_tax = ?, tax_amount = ?, gross_amount = ?
          WHERE id = ?`, [qty, subtotal, discAmount, net, tax, round2(net + tax), line.id]);
      await recomputeTotals(conn, req.params.id);
      await logAudit(conn, { id: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: `line ${line.line_no} qty`, oldValue: num(line.quantity), newValue: qty });
    }
    if (line.created_job_order_id) {
      await conn.query('UPDATE job_orders SET description = ?, job_location_id = ?, updated_at = NOW() WHERE id = ?', [description, jobLocationId, line.created_job_order_id]);
    }
    if (String(description || '') !== String(line.description || '')) {
      await logAudit(conn, { id: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: `line ${line.line_no} description`, oldValue: line.description, newValue: description });
    }
    if (String(jobLocationId || '') !== String(line.job_location_id || '')) {
      await logAudit(conn, { id: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: `line ${line.line_no} job_location_id`, oldValue: line.job_location_id, newValue: jobLocationId });
    }
    await conn.commit();
    const [[row]] = await pool.query(
      `SELECT l.*, jt.display_name AS job_type_name, jl.location_name AS job_location_name
         FROM non_standard_sales_order_lines l
         LEFT JOIN job_types jt ON jt.id = l.job_type_id
         LEFT JOIN locations jl ON jl.id = l.job_location_id
        WHERE l.id = ?`, [line.id]);
    res.json(row);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// A Sample line's Qty and Amount (asked 2026-10-03). A sample is copied from its Estimate line at
// the estimate's full quantity and value, but the customer is usually sampled one piece at a
// fraction of the price. Amount is the line's Net of Tax; the price per unit, tax and gross follow
// from it (at the line's own tax rate) so the NSSO total, the Create-JO quantity and the invoice
// all read the edited figures. Qty is locked once the line's Job Order exists -- the JO carries it.
router.put('/:id/lines/:lineId/sample', requireAuth, requireEditOrOwnDraft, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[n]] = await conn.query('SELECT type, status FROM non_standard_sales_orders WHERE id = ?', [req.params.id]);
    if (!n) return res.status(404).json({ error: 'Not found' });
    if (n.type !== 'sample') return res.status(409).json({ error: 'Only a Sample NSSO line has a sample quantity and amount.' });
    if (n.status === 'cancelled') return res.status(409).json({ error: 'This NSSO is cancelled.' });
    const [[line]] = await conn.query(
      `SELECT l.*, t.rate AS tax_rate FROM non_standard_sales_order_lines l LEFT JOIN taxes t ON t.id = l.tax_code_id
        WHERE l.id = ? AND l.nsso_id = ?`, [req.params.lineId, req.params.id]);
    if (!line) return res.status(404).json({ error: 'Line not found' });

    const qty = req.body.quantity === undefined ? num(line.quantity) : Number(req.body.quantity);
    const amount = req.body.amount === undefined ? num(line.sample_amount) : Number(req.body.amount);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Qty must be more than zero.' });
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Amount must be zero or more.' });

    // The line's own tax rate: its code's, else what it was carrying (tax / net).
    const rate = line.tax_rate != null ? num(line.tax_rate)
      : (num(line.net_of_tax) > 0 ? (num(line.tax_amount) / num(line.net_of_tax)) * 100 : 0);
    const net = round2(amount);
    const tax = round2(net * rate / 100);
    await conn.beginTransaction();
    if (Math.abs(qty - num(line.quantity)) > 1e-9) {
      const refusal = await moveJobOrderQty(conn, line, qty);
      if (refusal) { await conn.rollback(); return res.status(409).json({ error: refusal }); }
    }
    await conn.query(
      `UPDATE non_standard_sales_order_lines
          SET quantity = ?, sample_qty = ?, sample_amount = ?, price_per_unit = ?, subtotal = ?, disc_percent = 0,
              disc_amount = 0, net_of_tax = ?, tax_amount = ?, gross_amount = ?
        WHERE id = ?`,
      [qty, qty, net, Number((net / qty).toFixed(4)), net, net, tax, round2(net + tax), line.id]);
    await recomputeTotals(conn, req.params.id);
    if (Math.abs(qty - num(line.quantity)) > 1e-9) {
      await logAudit(conn, { id: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: `line ${line.line_no} sample qty`, oldValue: num(line.quantity), newValue: qty });
    }
    if (Math.abs(net - num(line.sample_amount)) > 0.005) {
      await logAudit(conn, { id: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: `line ${line.line_no} sample amount`, oldValue: round2(line.sample_amount), newValue: net });
    }
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM non_standard_sales_order_lines WHERE id = ?', [line.id]);
    res.json(row);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Who may approve this NSSO. A SAMPLE gives the customer work for nothing, so only an SBU head
// (users.is_sales_business_unit) -- or a System Admin -- approves one, and a sales supervisor's
// "NSSO Can Approve" does not reach it (asked 2026-10-06). Every other type is still governed by
// that permission alone.
async function mayApproveNsso(userId, type) {
  if (type === 'sample') {
    if (await isSystemAdmin(userId)) return true;
    const [[u]] = await pool.query('SELECT is_sales_business_unit FROM users WHERE id = ?', [userId]);
    return !!(u && u.is_sales_business_unit);
  }
  return userCan(userId, ROUTE, 'can_approve');
}

// Approve an NSSO, moving it from Pending / Needs Approval to JO In-Process -- see mayApproveNsso.
router.put('/:id/approve', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[n]] = await conn.query('SELECT status, type FROM non_standard_sales_orders WHERE id = ?', [req.params.id]);
    if (!n) return res.status(404).json({ error: 'Not found' });
    if (!(await mayApproveNsso(req.user.id, n.type))) {
      return res.status(403).json({ error: n.type === 'sample' ? 'Only an SBU head can approve a Sample NSSO.' : 'You do not have permission to perform this action' });
    }
    if (n.status === 'cancelled') return res.status(409).json({ error: 'This NSSO is cancelled.' });
    if (n.status !== 'pending_approval') return res.status(409).json({ error: 'This NSSO is not pending approval.' });
    // An NSSO with nothing on it is not ready to approve (NSSO-SAM-2438 went through with no lines,
    // and Production then has no job order to make).
    const [[cnt]] = await conn.query('SELECT COUNT(*) AS n FROM non_standard_sales_order_lines WHERE nsso_id = ?', [req.params.id]);
    if (!Number(cnt.n)) return res.status(409).json({ error: 'This NSSO has no lines yet. Add its job lines before approving it.' });
    const [[u]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    await conn.beginTransaction();
    // Approved but no JOs created yet -> Pending for JO. It flips to JO In-Process once JOs are made.
    await conn.query("UPDATE non_standard_sales_orders SET status = 'pending_for_jo', approved_at = NOW(), approved_by_id = ? WHERE id = ?", [u?.employee_id || null, req.params.id]);
    await logAudit(conn, { id: req.params.id, userId: req.user.id, eventType: 'Approved', fieldName: 'status', oldValue: n.status, newValue: 'pending_for_jo' });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM non_standard_sales_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Draft for the Create-JO modal: the item's JO header info + its processes (pre-filled from the
// source/nested-SO job order, editable in the modal before saving).
router.get('/:id/lines/:lineId/jo-draft', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[line]] = await pool.query(
      `SELECT l.*, jt.display_name AS job_type_name, jl.location_name AS job_location_name,
              n.customer_id, c.name AS customer_name, cp.contact_name AS contact_person_name, n.contact_phone,
              n.office_location_id, loc.location_name AS office_location_name, n.sales_division_id, sd.name AS sales_division_name,
              n.sales_rep_id, CONCAT(e.first_name, ' ', e.last_name) AS sales_rep_name, sjo.job_order_no AS source_job_order_no
       FROM non_standard_sales_order_lines l
       JOIN non_standard_sales_orders n ON n.id = l.nsso_id
       LEFT JOIN job_types jt ON jt.id = l.job_type_id
       LEFT JOIN locations jl ON jl.id = l.job_location_id
       LEFT JOIN customers c ON c.id = n.customer_id
       LEFT JOIN customer_contacts cp ON cp.id = n.contact_person_id
       LEFT JOIN locations loc ON loc.id = n.office_location_id
       LEFT JOIN sales_divisions sd ON sd.id = n.sales_division_id
       LEFT JOIN employees e ON e.id = n.sales_rep_id
       LEFT JOIN job_orders sjo ON sjo.id = l.source_job_order_id
       WHERE l.id = ? AND l.nsso_id = ?`,
      [req.params.lineId, req.params.id]
    );
    if (!line) return res.status(404).json({ error: 'Line not found' });
    // Pre-fill the modal's process grid: RMA copies the source JO's processes; Sample copies the
    // estimate job order's processes; Internal has neither, so it opens with an empty grid.
    let processes = [];
    if (line.source_job_order_id) {
      [processes] = await pool.query(
        `SELECT jop.line_no, jop.process_id, p.process_name, jop.process_qty, jop.process_uom, jop.category, jop.parts,
                jop.item_id, i.display_name AS item_name, jop.length, jop.width, jop.uom, jop.qty, jop.unit, jop.remarks
         FROM job_order_processes jop
         LEFT JOIN processes p ON p.id = jop.process_id
         LEFT JOIN inventories i ON i.id = jop.item_id
         WHERE jop.job_order_id = ? ORDER BY jop.line_no`,
        [line.source_job_order_id]
      );
    } else if (line.source_estimate_job_order_id) {
      [processes] = await pool.query(
        `SELECT ejp.line_no, ejp.process_id, p.process_name, ejp.process_qty, ejp.process_uom, ejp.category, ejp.parts,
                ejp.item_id, i.display_name AS item_name, ejp.length, ejp.width, ejp.uom, ejp.qty, ejp.unit, ejp.remarks
         FROM estimate_job_order_processes ejp
         LEFT JOIN processes p ON p.id = ejp.process_id
         LEFT JOIN inventories i ON i.id = ejp.item_id
         WHERE ejp.estimate_job_order_id = ? ORDER BY ejp.line_no`,
        [line.source_estimate_job_order_id]
      );
    }
    res.json({ line, processes });
  } catch (err) { next(err); }
});

// Create the production Job Order for one NSSO item (from the Create-JO modal). Only once the NSSO
// is approved. Saves the reason code / reason / action taken and the (possibly edited) processes.
// Number = NSJO-<TYPE>-<nssoNumber>-<sequence>-<totalItems> (the redo JO still reuses the source
// SO + line, which are NOT NULL on job_orders, and back-links via nsso_id/nsso_line_id).
router.post('/:id/lines/:lineId/create-jo', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[nsso]] = await conn.query('SELECT id, nsso_no, type, status, sales_rep_id, contact_email, contact_title, contact_phone, shipping_address FROM non_standard_sales_orders WHERE id = ?', [req.params.id]);
    if (!nsso) return res.status(404).json({ error: 'Not found' });
    if (nsso.status === 'pending_approval') return res.status(409).json({ error: 'Approve the NSSO before creating job orders.' });
    if (nsso.status === 'cancelled') return res.status(409).json({ error: 'This NSSO is cancelled.' });
    const [[line]] = await conn.query('SELECT * FROM non_standard_sales_order_lines WHERE id = ? AND nsso_id = ?', [req.params.lineId, req.params.id]);
    if (!line) return res.status(404).json({ error: 'Line not found' });
    if (line.created_job_order_id) return res.status(409).json({ error: 'A job order was already created for this item.' });
    // RMA/RMA-Installation redo an existing (source) job order; INTERNAL is raised from scratch and
    // has none -- so src (and the reused SO ids) are only present for the nested types.
    const [[src]] = line.source_job_order_id
      ? await conn.query('SELECT id, sales_order_id, sales_order_line_id, sales_rep_id FROM job_orders WHERE id = ?', [line.source_job_order_id])
      : [[null]];
    if (line.source_job_order_id && !src) return res.status(409).json({ error: 'This item has no source job order to base the JO on.' });

    const { reason_code_id: reasonCodeId, reason, action_to_be_taken: actionTaken, processes } = req.body;
    // Every type -- RMA, RMA-Installation, Sample, Internal -- goes through the same chain as a
    // standard JO (2026-10-02, "all NSJO treat it like a standard JO"): straight into the Design
    // Supervisor's queue to be assigned an artist, then layout, Sales Approval and Production.
    // The NSSO's own approval was the supervisor's, so the old "Pending RMA Approval" / "Pending
    // Approval" step is no longer entered (JOs already parked there keep their RMA buttons).
    const initialStatus = DESIGN_QUEUE_STATUS;
    const initialSubStatus = 'For Design Supervisor';

    await conn.beginTransaction();
    // Number: NSJO-<TYPE>-<nssoNum>-<seq>-<total>. TYPE + nssoNum come from the NSSO doc no.
    // NSSO-RMA-177 -> RMA, 177. Everything after the type is taken as the number, so the -O on the
    // few NSSOs the office box numbered that way on 2026-10-03 carries into their NSJO numbers.
    const [, abbr, ...numParts] = (nsso.nsso_no || '').split('-');
    const nssoNum = numParts.join('-');
    const [[cnt]] = await conn.query('SELECT COUNT(*) AS n FROM non_standard_sales_order_lines WHERE nsso_id = ?', [nsso.id]);
    const jobOrderNo = `NSJO-${abbr}-${nssoNum}-${line.line_no}-${cnt.n}`;
    // The JO carries the NSSO's Sales Rep (else the source JO's). Sales users only see job orders
    // whose sales_rep_id is in their team, so a JO created without one was invisible -- a 404 --
    // to the very rep who raised it (NSJO-INT-51-1-1).
    const salesRepId = nsso.sales_rep_id || src?.sales_rep_id || null;
    const [r] = await conn.query(
      // production_stage NULL until Sales Approval releases it, as for a standard JO.
      `INSERT INTO job_orders (job_order_no, sales_order_line_id, sales_order_id, nsso_id, nsso_line_id, sales_rep_id,
         job_type_id, job_location_id, description, quantity, units, length, width, height,
         reason_code_id, reason, action_to_be_taken, production_stage, sub_status, status,
         contact_email, contact_title, contact_phone, shipping_address)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)`,
      [jobOrderNo, src?.sales_order_line_id || null, src?.sales_order_id || null, nsso.id, line.id, salesRepId,
       line.job_type_id, line.job_location_id, line.description, num(line.quantity), line.units, line.length, line.width, line.height,
       reasonCodeId || null, trunc(reason, 500), trunc(actionTaken, 500), initialSubStatus, initialStatus,
       // The NSSO's contact and shipping address, as a sales order's job order carries its SO's.
       nsso.contact_email || null, nsso.contact_title || null, nsso.contact_phone || null, nsso.shipping_address || null]
    );
    const joId = r.insertId;

    // Processes: the (edited) rows from the modal. For a nested type with none sent, copy the source
    // JO's processes verbatim; internal has no source, so it simply starts with whatever was entered.
    if (Array.isArray(processes) && processes.length) {
      let ln = 0;
      for (const pr of processes) {
        ln += 1;
        await conn.query(
          `INSERT INTO job_order_processes (job_order_id, line_no, process_id, process_qty, process_uom, category, parts, item_id, length, width, uom, qty, unit, remarks)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [joId, ln, pr.process_id || null, num(pr.process_qty), trunc(pr.process_uom, 50), trunc(pr.category, 100), trunc(pr.parts, 255),
           pr.item_id || null, decOrNull(pr.length), decOrNull(pr.width), trunc(pr.uom, 50), num(pr.qty), trunc(pr.unit, 50), trunc(pr.remarks, 500)]
        );
      }
    } else if (src) {
      const [pcols] = await conn.query('SHOW COLUMNS FROM job_order_processes');
      const copy = pcols.map((c) => c.Field).filter((f) => f !== 'id' && f !== 'job_order_id');
      await conn.query(
        `INSERT INTO job_order_processes (job_order_id, ${copy.join(', ')}) SELECT ?, ${copy.join(', ')} FROM job_order_processes WHERE job_order_id = ?`,
        [joId, src.id]
      );
    }

    await conn.query('UPDATE non_standard_sales_order_lines SET created_job_order_id = ? WHERE id = ?', [joId, line.id]);
    if (nsso.status === 'pending_for_jo') await conn.query("UPDATE non_standard_sales_orders SET status = 'jo_in_process' WHERE id = ?", [nsso.id]);
    await logAudit(conn, { id: nsso.id, userId: req.user.id, eventType: 'Updated', fieldName: 'created_job_order', newValue: jobOrderNo });
    // It lands in the design queue with no artist on it -- tell the supervisors, the same
    // hand-off as a standard JO's Forward to Design Supervisor.
    await notifyDesignSupervisors(conn, {
      title: `${jobOrderNo} needs an artist assigned`,
      message: line.description ? String(line.description).slice(0, 500) : null,
      relatedType: 'JobOrder', relatedId: joId, excludeUserId: req.user.id,
    });
    await conn.commit();
    res.status(201).json({ job_order_id: joId, job_order_no: jobOrderNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[n]] = await conn.query('SELECT status FROM non_standard_sales_orders WHERE id = ?', [req.params.id]);
    if (!n) return res.status(404).json({ error: 'Not found' });
    if (n.status === 'cancelled') return res.status(409).json({ error: 'Already cancelled.' });
    await conn.beginTransaction();
    await conn.query("UPDATE non_standard_sales_orders SET status='cancelled', cancelled_at=NOW(), cancelled_by_user_id=? WHERE id=?", [req.user.id, req.params.id]);
    await logAudit(conn, { id: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: n.status, newValue: 'cancelled' });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM non_standard_sales_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
