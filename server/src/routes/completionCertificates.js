const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
// Certificate of Completion (COC-##, 2026-10-28), as the source's completion_certificate_crud: raised
// against a BILLED Sales Order -- PO #, Customer, Submitted By, Project Name, Location, Contract
// Package -- signed by the customer's own contact persons, a list of Approvers and one of Certifiers.
// Pending Approval -> Approved (only then Printed) -> Void, as the Warranty Certificate.
const ROUTE = '/completion-certificates';
const ROLES = ['approver', 'certifier'];

const trunc = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));
const day = (v) => (v ? String(v).slice(0, 10) : null);

async function logAudit(conn, { cocId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('CompletionCertificate', ?, ?, ?, ?, ?, ?)`,
    [cocId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId]);
}

// The Sales Orders list: billed ones, as the source's picker (SO #, Date, Customer, Total, Status).
// The newest 200, or those matching what is typed -- every billed SO is reachable by searching.
router.get('/billable-sales-orders', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const q = String(req.query.search || '').trim();
    const [rows] = await pool.query(
      `SELECT so.id, so.sales_order_no, so.date_created, so.total_amount, so.status, so.customer_id, c.name AS customer_name
         FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id
        WHERE so.status = 'billed' ${q ? 'AND (so.sales_order_no LIKE ? OR c.name LIKE ?)' : ''}
        ORDER BY so.id DESC LIMIT 200`, q ? [`%${q}%`, `%${q}%`] : []);
    res.json(rows);
  } catch (err) { next(err); }
});

const contactsOf = async (customerId) => {
  const [rows] = await pool.query(
    `SELECT id, contact_name, email, phone, title, description, is_approver, is_certifier
       FROM customer_contacts WHERE customer_id = ? ORDER BY contact_name`, [customerId]);
  return rows;
};

// What a certificate pulls from the chosen Sales Order, and the customer's contact persons.
router.get('/source-sales-order/:soId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[so]] = await pool.query(
      `SELECT so.id, so.sales_order_no, so.date_created, so.customer_id, so.order_confirmation_ref AS po_no,
              so.contract_description, so.shipping_address, so.sales_rep_id,
              c.name AS customer_name, CONCAT_WS(' ', e.first_name, e.last_name) AS sales_rep_name
         FROM sales_orders so
         LEFT JOIN customers c ON c.id = so.customer_id
         LEFT JOIN employees e ON e.id = so.sales_rep_id
        WHERE so.id = ?`, [req.params.soId]);
    if (!so) return res.status(404).json({ error: 'Sales Order not found' });
    res.json({ sales_order: so, contacts: so.customer_id ? await contactsOf(so.customer_id) : [] });
  } catch (err) { next(err); }
});

router.get('/contacts', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    if (!Number(req.query.customer_id)) return res.json([]);
    res.json(await contactsOf(Number(req.query.customer_id)));
  } catch (err) { next(err); }
});

// "Add New" on the Contact Person picker: a new contact person of the customer, flagged as the role
// it is added for, so it is offered there next time.
router.post('/contacts', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const customerId = Number(b.customer_id);
    if (!customerId) return res.status(400).json({ error: 'Pick the Sales Order first.' });
    const name = trunc(b.contact_name, 255);
    if (!name) return res.status(400).json({ error: 'Enter the contact person\'s name.' });
    const [r] = await pool.query(
      `INSERT INTO customer_contacts (customer_id, contact_name, title, email, phone, description, is_approver, is_certifier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [customerId, name, trunc(b.title, 255), trunc(b.email, 255), trunc(b.phone, 100), trunc(b.description, 500),
        b.role === 'approver' ? 1 : 0, b.role === 'certifier' ? 1 : 0]);
    const [[row]] = await pool.query(
      'SELECT id, contact_name, email, phone, title, description, is_approver, is_certifier FROM customer_contacts WHERE id = ?', [r.insertId]);
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('cc.status = ?'); params.push(status); }
    if (search) {
      where.push('(cc.coc_no LIKE ? OR c.name LIKE ? OR so.sales_order_no LIKE ? OR cc.project_name LIKE ? OR cc.po_no LIKE ?)');
      const q = `%${search}%`;
      params.push(q, q, q, q, q);
    }
    const [rows] = await pool.query(
      `SELECT cc.id, cc.coc_no, cc.date_created, cc.status, cc.project_name, cc.po_no, cc.submitted_by_name,
              cc.customer_id, c.name AS customer_name, so.sales_order_no
         FROM completion_certificates cc
         LEFT JOIN customers c ON c.id = cc.customer_id
         LEFT JOIN sales_orders so ON so.id = cc.sales_order_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY cc.id DESC`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[cc]] = await pool.query(
      `SELECT cc.*, c.name AS customer_name, so.sales_order_no, so.date_created AS sales_order_date,
              au.display_name AS approved_by_name
         FROM completion_certificates cc
         LEFT JOIN customers c ON c.id = cc.customer_id
         LEFT JOIN sales_orders so ON so.id = cc.sales_order_id
         LEFT JOIN users au ON au.id = cc.approved_by_user_id
        WHERE cc.id = ?`, [req.params.id]);
    if (!cc) return res.status(404).json({ error: 'Not found' });
    const [signers] = await pool.query(
      'SELECT * FROM completion_certificate_signers WHERE coc_id = ? ORDER BY role, line_no', [req.params.id]);
    res.json({
      ...cc,
      approvers: signers.filter((s) => s.role === 'approver'),
      certifiers: signers.filter((s) => s.role === 'certifier'),
    });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
        WHERE a.auditable_type = 'CompletionCertificate' AND a.auditable_id = ? ORDER BY a.set_at DESC`, [req.params.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

async function writeSigners(conn, cocId, b) {
  await conn.query('DELETE FROM completion_certificate_signers WHERE coc_id = ?', [cocId]);
  for (const role of ROLES) {
    const list = (Array.isArray(b[`${role}s`]) ? b[`${role}s`] : []).filter((s) => trunc(s?.name, 255)).slice(0, 30);
    let lineNo = 0;
    for (const s of list) {
      lineNo += 1;
      await conn.query(
        `INSERT INTO completion_certificate_signers (coc_id, role, line_no, contact_id, name, job_title) VALUES (?, ?, ?, ?, ?, ?)`,
        [cocId, role, lineNo, Number(s.contact_id) || null, trunc(s.name, 255), trunc(s.job_title, 255)]);
    }
  }
}

const headerValues = (b) => [
  day(b.date_created) || new Date().toISOString().slice(0, 10), trunc(b.po_no, 100),
  Number(b.submitted_by_employee_id) || null, trunc(b.submitted_by_name, 150),
  trunc(b.project_name, 500), trunc(b.location, 500), trunc(b.contract_package, 1000),
];

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    if (!b.sales_order_id) return res.status(400).json({ error: 'Select the (billed) Sales Order this certificate is for.' });
    const [[so]] = await conn.query('SELECT status, customer_id FROM sales_orders WHERE id = ?', [b.sales_order_id]);
    if (!so) return res.status(400).json({ error: 'Sales Order not found.' });
    if (so.status !== 'billed') return res.status(409).json({ error: 'A Certificate of Completion can only be created for a billed Sales Order.' });

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO completion_certificates
         (coc_no, sales_order_id, customer_id, date_created, po_no, submitted_by_employee_id, submitted_by_name,
          project_name, location, contract_package, status, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?)`,
      [b.sales_order_id, so.customer_id, ...headerValues(b), req.user.id]);
    const cocId = r.insertId;
    const cocNo = `COC-${cocId}`;
    await conn.query('UPDATE completion_certificates SET coc_no = ? WHERE id = ?', [cocNo, cocId]);
    await writeSigners(conn, cocId, b);
    await logAudit(conn, { cocId, userId: req.user.id, eventType: 'Created', fieldName: 'coc_no', newValue: cocNo });
    await conn.commit();
    res.status(201).json({ id: cocId, coc_no: cocNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[cc]] = await conn.query('SELECT status FROM completion_certificates WHERE id = ?', [req.params.id]);
    if (!cc) return res.status(404).json({ error: 'Not found' });
    if (cc.status === 'voided') return res.status(409).json({ error: 'A voided certificate cannot be edited.' });
    if (cc.status === 'approved') return res.status(409).json({ error: 'An approved certificate cannot be edited.' });
    const b = req.body || {};
    await conn.beginTransaction();
    await conn.query(
      `UPDATE completion_certificates SET date_created = ?, po_no = ?, submitted_by_employee_id = ?, submitted_by_name = ?,
              project_name = ?, location = ?, contract_package = ?, updated_at = NOW() WHERE id = ?`,
      [...headerValues(b), req.params.id]);
    await writeSigners(conn, req.params.id, b);
    await logAudit(conn, { cocId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'certificate' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id/approve', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[cc]] = await conn.query('SELECT status FROM completion_certificates WHERE id = ?', [req.params.id]);
    if (!cc) return res.status(404).json({ error: 'Not found' });
    if (cc.status !== 'pending_approval') return res.status(409).json({ error: `This certificate is already ${cc.status}.` });
    await conn.beginTransaction();
    await conn.query("UPDATE completion_certificates SET status = 'approved', approved_at = NOW(), approved_by_user_id = ? WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { cocId: req.params.id, userId: req.user.id, eventType: 'Approved', fieldName: 'status', oldValue: cc.status, newValue: 'approved' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[cc]] = await conn.query('SELECT status FROM completion_certificates WHERE id = ?', [req.params.id]);
    if (!cc) return res.status(404).json({ error: 'Not found' });
    if (cc.status === 'voided') return res.status(409).json({ error: 'Already voided.' });
    await conn.beginTransaction();
    await conn.query("UPDATE completion_certificates SET status = 'voided', voided_at = NOW(), voided_by_user_id = ? WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { cocId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: cc.status, newValue: 'voided' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
