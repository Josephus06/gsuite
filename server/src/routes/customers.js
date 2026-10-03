const express = require('express');
const pool = require('../db');
const { findCustomerByName, duplicateMessage, nameKey } = require('../lib/customerDuplicates');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { upperCustomerName, CUSTOMER_NAME_FIELDS } = require('../lib/customerName');

const router = express.Router();
const ROUTE = '/customers';

// The header, as the "Setup Your Customer" form (client/src/pages/CustomerForm.jsx) lays it out --
// the old system's customer screen -- plus the T1S-only fields (code, company, sales division,
// default rep, active) that form does not show but a save must carry through unchanged.
const FIELDS = [
  'customer_code', 'name', 'company_name', 'business_style_id', 'tin',
  'payment_term_id', 'credit_limit', 'sales_division_id', 'default_sales_rep_id', 'is_active',
  'address', 'tax_id', 'birthdate', 'gender', 'contact_no', 'customer_type',
  'is_charge_to_location', 'is_ewt', 'is_final_tax', 'is_charge_to', 'include_90_commission',
  'bill_to_name', 'bill_to_address', 'bill_to_contact_no',
];
const FLAGS = ['is_charge_to_location', 'is_ewt', 'is_final_tax', 'is_charge_to', 'include_90_commission'];
const CONTACT_FIELDS = ['contact_name', 'address', 'title', 'email', 'phone', 'description', 'is_primary',
  'is_default_bill_to', 'is_approver', 'is_certifier', 'birthday', 'personal_notes'];
const CONTACT_FLAGS = ['is_primary', 'is_default_bill_to', 'is_approver', 'is_certifier'];

const blank = (v) => (v === undefined || v === '' ? null : v);

// Names are stored upper-cased whatever was typed -- see lib/customerName.js. Applied to the
// values on their way into the statement rather than to req.body, so there is one place per
// route where it happens and no chance of writing the raw value by a path that skipped it.
const withUpperNames = (body) => FIELDS.map((f) => {
  if (FLAGS.includes(f)) return body[f] ? 1 : 0;
  if (f === 'is_active') return body[f] === undefined ? 1 : (body[f] ? 1 : 0);
  if (f === 'credit_limit') return Number(body[f]) || 0;
  const raw = blank(body[f]) ?? null;
  return CUSTOMER_NAME_FIELDS.includes(f) ? upperCustomerName(raw) : raw;
});
const contactValues = (c) => CONTACT_FIELDS.map((f) => (CONTACT_FLAGS.includes(f) ? (c[f] ? 1 : 0) : (blank(c[f]) ?? null)));

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      // address: the customer's default address (else its first), else the address on the customer
      // itself, else its bill-to address -- the Delivery Ticket and invoice screens' pick, plus bill-to.
      `SELECT c.*, bs.name AS business_style_name, pt.term_name AS payment_term_name, sd.name AS sales_division_name,
              COALESCE((SELECT ca.address_line FROM customer_addresses ca WHERE ca.customer_id = c.id ORDER BY ca.is_default DESC, ca.id LIMIT 1), NULLIF(c.address, ''), NULLIF(c.bill_to_address, '')) AS list_address
       FROM customers c
       LEFT JOIN business_styles bs ON bs.id = c.business_style_id
       LEFT JOIN payment_terms pt ON pt.id = c.payment_term_id
       LEFT JOIN sales_divisions sd ON sd.id = c.sales_division_id
       ORDER BY c.id DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[customer]] = await pool.query(
      `SELECT c.*, pt.term_name AS payment_term_name FROM customers c
         LEFT JOIN payment_terms pt ON pt.id = c.payment_term_id WHERE c.id = ?`, [req.params.id]);
    if (!customer) return res.status(404).json({ error: 'Not found' });
    const [contacts] = await pool.query('SELECT * FROM customer_contacts WHERE customer_id = ? ORDER BY id', [req.params.id]);
    const [addresses] = await pool.query('SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY id', [req.params.id]);
    const [relationships] = await pool.query('SELECT * FROM customer_relationships WHERE customer_id = ? ORDER BY id', [req.params.id]);
    res.json({ ...customer, contacts, addresses, relationships });
  } catch (err) {
    next(err);
  }
});

// The form's tabs travel with the header: `contacts`, `addresses` (shipping) and `relationships`,
// each an array whose rows carry an id when they already exist. On an edit, rows are updated by
// id, new ones inserted, and ones left out removed -- except a contact or address something else
// still points at (an estimate's contact person ...), which is kept and reported, not broken.
async function syncChildren(conn, customerId, body) {
  const kept = [];
  if (Array.isArray(body.contacts)) {
    const rows = body.contacts.filter((c) => String(c.contact_name || '').trim());
    const ids = rows.map((c) => Number(c.id)).filter(Boolean);
    const [gone] = await conn.query('SELECT id, contact_name FROM customer_contacts WHERE customer_id = ? AND id NOT IN (?)', [customerId, ids.length ? ids : [0]]);
    for (const g of gone) {
      try { await conn.query('DELETE FROM customer_contacts WHERE id = ?', [g.id]); } catch (e) {
        if (e.code !== 'ER_ROW_IS_REFERENCED_2') throw e;
        kept.push(`contact ${g.contact_name} (used on other documents)`);
      }
    }
    for (const c of rows) {
      if (c.id) {
        await conn.query(`UPDATE customer_contacts SET ${CONTACT_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ? AND customer_id = ?`,
          [...contactValues(c), c.id, customerId]);
      } else {
        await conn.query(`INSERT INTO customer_contacts (customer_id, ${CONTACT_FIELDS.join(', ')}) VALUES (?, ${CONTACT_FIELDS.map(() => '?').join(', ')})`,
          [customerId, ...contactValues(c)]);
      }
    }
  }
  if (Array.isArray(body.addresses)) {
    const rows = body.addresses.filter((a) => String(a.address_line || '').trim());
    const ids = rows.map((a) => Number(a.id)).filter(Boolean);
    const [gone] = await conn.query('SELECT id, address_line FROM customer_addresses WHERE customer_id = ? AND id NOT IN (?)', [customerId, ids.length ? ids : [0]]);
    for (const g of gone) {
      try { await conn.query('DELETE FROM customer_addresses WHERE id = ?', [g.id]); } catch (e) {
        if (e.code !== 'ER_ROW_IS_REFERENCED_2') throw e;
        kept.push(`address ${String(g.address_line).slice(0, 40)} (used on other documents)`);
      }
    }
    for (const a of rows) {
      const v = [a.address_type || 'Shipping', a.address_line, a.is_default ? 1 : 0];
      if (a.id) await conn.query('UPDATE customer_addresses SET address_type = ?, address_line = ?, is_default = ?, updated_at = NOW() WHERE id = ? AND customer_id = ?', [...v, a.id, customerId]);
      else await conn.query('INSERT INTO customer_addresses (customer_id, address_type, address_line, is_default) VALUES (?, ?, ?, ?)', [customerId, ...v]);
    }
  }
  if (Array.isArray(body.relationships)) {
    const rows = body.relationships.filter((r) => String(r.name || '').trim());
    const ids = rows.map((r) => Number(r.id)).filter(Boolean);
    await conn.query('DELETE FROM customer_relationships WHERE customer_id = ? AND id NOT IN (?)', [customerId, ids.length ? ids : [0]]);
    for (const r of rows) {
      const v = [r.name, blank(r.address) ?? null, blank(r.contact_no) ?? null];
      if (r.id) await conn.query('UPDATE customer_relationships SET name = ?, address = ?, contact_no = ?, updated_at = NOW() WHERE id = ? AND customer_id = ?', [...v, r.id, customerId]);
      else await conn.query('INSERT INTO customer_relationships (customer_id, name, address, contact_no) VALUES (?, ?, ?, ?)', [customerId, ...v]);
    }
  }
  return kept;
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    if (!String(req.body.name || '').trim()) return res.status(400).json({ error: 'Name is required.' });
    const dup = await findCustomerByName(conn, req.body.name);
    if (dup) return res.status(409).json({ error: duplicateMessage(dup), existing_customer_id: dup.id });
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO customers (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
      withUpperNames(req.body)
    );
    const customerId = result.insertId;
    await syncChildren(conn, customerId, req.body);
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM customers WHERE id = ?', [customerId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Customer code already in use' });
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    if (!String(req.body.name || '').trim()) return res.status(400).json({ error: 'Name is required.' });
    const [[current]] = await conn.query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Not found' });
    // A field the caller did not send keeps its value, so a screen that knows fewer fields than
    // this route cannot blank the rest.
    const merged = { ...req.body };
    for (const f of FIELDS) if (merged[f] === undefined) merged[f] = current[f];
    // Renaming onto another customer's name is a duplicate too. Only checked when the name
    // actually changes, so a customer already sharing a name (from before this rule) can still
    // be edited.
    if (nameKey(merged.name) !== nameKey(current.name)) {
      const dup = await findCustomerByName(conn, merged.name, current.id);
      if (dup) return res.status(409).json({ error: duplicateMessage(dup), existing_customer_id: dup.id });
    }
    await conn.beginTransaction();
    await conn.query(
      `UPDATE customers SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...withUpperNames(merged), req.params.id]
    );
    const kept = await syncChildren(conn, req.params.id, req.body);
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    res.json({ ...row, kept });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Customer code already in use' });
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM customer_contacts WHERE customer_id = ?', [req.params.id]);
    await conn.query('DELETE FROM customer_addresses WHERE customer_id = ?', [req.params.id]);
    await conn.query('DELETE FROM customer_relationships WHERE customer_id = ?', [req.params.id]);
    await conn.query('DELETE FROM customers WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This customer is referenced by other data and cannot be deleted.' });
    }
    next(err);
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------- the form's read-only tabs

// Transactions: every sales document of this customer, newest first -- estimates, SOs, DTs,
// invoices (whose customer is the SO's, or the estimate's when billed straight from one) and
// customer payments. Filters as the old screen: Transaction #, As of / date range, Sales Rep,
// Status.
const LEDGER_SQL = `
  SELECT 'Estimate' AS doc_type, e.id, e.estimate_no AS doc_no, e.date_created AS doc_date, e.status, e.sales_rep_id, e.total_amount AS amount
    FROM estimates e WHERE e.customer_id = ?
  UNION ALL
  SELECT 'Sales Order', s.id, s.sales_order_no, s.date_created, s.status, s.sales_rep_id, s.total_amount
    FROM sales_orders s WHERE s.customer_id = ?
  UNION ALL
  SELECT 'Delivery Ticket', d.id, d.dt_no, d.date_created, d.status, d.sales_rep_id, d.gross_amount
    FROM delivery_tickets d JOIN sales_orders s ON s.id = d.sales_order_id WHERE s.customer_id = ?
  UNION ALL
  SELECT 'Invoice', si.id, si.invoice_no, si.date_created, si.status, si.sales_rep_id, si.gross_amount
    FROM sales_invoices si LEFT JOIN sales_orders s ON s.id = si.sales_order_id LEFT JOIN estimates e ON e.id = si.estimate_id
   WHERE COALESCE(s.customer_id, e.customer_id) = ?
  UNION ALL
  SELECT 'Customer Payment', p.id, p.customer_payment_no, p.date_created, p.status, NULL, p.payment_amount
    FROM customer_payments p WHERE p.customer_id = ?
`;

router.get('/:id/transactions', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { doc_no: docNo, as_of: asOf, date_from: from, date_to: to, sales_rep_id: rep, status } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
    const id = req.params.id;
    const params = [id, id, id, id, id];
    const where = [];
    if (docNo) { where.push('t.doc_no LIKE ?'); params.push(`%${docNo}%`); }
    if (asOf) { where.push('t.doc_date <= ?'); params.push(asOf); }
    if (from) { where.push('t.doc_date >= ?'); params.push(from); }
    if (to) { where.push('t.doc_date <= ?'); params.push(to); }
    if (rep) { where.push('t.sales_rep_id = ?'); params.push(rep); }
    if (status) { where.push('t.status LIKE ?'); params.push(`%${status}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM (${LEDGER_SQL}) t ${whereSql}`, params);
    const [rows] = await pool.query(
      `SELECT t.*, CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name
         FROM (${LEDGER_SQL}) t LEFT JOIN employees sr ON sr.id = t.sales_rep_id
         ${whereSql} ORDER BY t.doc_date DESC, t.doc_no DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]);
    res.json({ rows, total, page, limit });
  } catch (err) {
    next(err);
  }
});

// Financial and Billing & Collection: what the customer owes and how that stands against their
// credit, and the open invoices behind it.
const OPEN_INVOICES_SQL = `
  SELECT si.id, si.invoice_no, si.bs_si_no, si.date_created, si.date_due, si.gross_amount, si.amount_due, si.status,
         si.collection_forecast_date, DATEDIFF(CURDATE(), si.date_due) AS days_overdue
    FROM sales_invoices si LEFT JOIN sales_orders s ON s.id = si.sales_order_id LEFT JOIN estimates e ON e.id = si.estimate_id
   WHERE COALESCE(s.customer_id, e.customer_id) = ? AND si.status NOT IN ('cancelled', 'void') AND si.amount_due > 0.005`;

router.get('/:id/financial', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const id = req.params.id;
    const [[c]] = await pool.query(
      'SELECT c.credit_limit, pt.term_name FROM customers c LEFT JOIN payment_terms pt ON pt.id = c.payment_term_id WHERE c.id = ?', [id]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const [[ar]] = await pool.query(`SELECT COUNT(*) n, COALESCE(SUM(amount_due), 0) due,
        COALESCE(SUM(CASE WHEN date_due < CURDATE() THEN amount_due END), 0) overdue FROM (${OPEN_INVOICES_SQL}) x`, [id]);
    const [[pay]] = await pool.query(`SELECT COALESCE(SUM(unapplied_amount), 0) unapplied, MAX(date_created) last_date
        FROM customer_payments WHERE customer_id = ? AND status NOT IN ('void', 'cancelled')`, [id]);
    const [[last]] = await pool.query(`SELECT customer_payment_no, date_created, payment_amount FROM customer_payments
        WHERE customer_id = ? AND status NOT IN ('void', 'cancelled') ORDER BY date_created DESC, id DESC LIMIT 1`, [id]);
    const [[ytd]] = await pool.query(`SELECT COALESCE(SUM(si.gross_amount), 0) sales FROM sales_invoices si
        LEFT JOIN sales_orders s ON s.id = si.sales_order_id LEFT JOIN estimates e ON e.id = si.estimate_id
        WHERE COALESCE(s.customer_id, e.customer_id) = ? AND si.status NOT IN ('cancelled', 'void') AND YEAR(si.date_created) = YEAR(CURDATE())`, [id]);
    const limit = Number(c.credit_limit || 0);
    res.json({
      credit_limit: limit, credit_term: c.term_name, open_invoices: ar.n, balance: Number(ar.due), overdue: Number(ar.overdue),
      available_credit: limit ? limit - Number(ar.due) : null, unapplied_payments: Number(pay.unapplied),
      last_payment: last || null, sales_this_year: Number(ytd.sales),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/open-invoices', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(`${OPEN_INVOICES_SQL} ORDER BY si.date_due, si.id`, [req.params.id]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// --- Contacts ---
router.post('/:id/contacts', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      `INSERT INTO customer_contacts (customer_id, ${CONTACT_FIELDS.join(', ')}) VALUES (?, ${CONTACT_FIELDS.map(() => '?').join(', ')})`,
      [req.params.id, ...contactValues(req.body)]
    );
    const [[row]] = await pool.query('SELECT * FROM customer_contacts WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

// Full replace of one contact, like PUT /customers/:id -- the caller sends every field.
router.put('/:id/contacts/:contactId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    if (!req.body.contact_name) return res.status(400).json({ error: 'Contact name is required.' });
    const [result] = await pool.query(
      `UPDATE customer_contacts SET ${CONTACT_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW()
        WHERE id = ? AND customer_id = ?`,
      [...contactValues(req.body), req.params.contactId, req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    const [[row]] = await pool.query('SELECT * FROM customer_contacts WHERE id = ?', [req.params.contactId]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/contacts/:contactId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM customer_contacts WHERE id = ? AND customer_id = ?', [req.params.contactId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// --- Addresses ---
router.post('/:id/addresses', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { address_type, address_line, is_default } = req.body;
    const [result] = await pool.query(
      `INSERT INTO customer_addresses (customer_id, address_type, address_line, is_default) VALUES (?, ?, ?, ?)`,
      [req.params.id, address_type || 'Shipping', address_line, !!is_default]
    );
    const [[row]] = await pool.query('SELECT * FROM customer_addresses WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/addresses/:addressId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM customer_addresses WHERE id = ? AND customer_id = ?', [req.params.addressId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
