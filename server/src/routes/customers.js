const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/customers';

const FIELDS = [
  'customer_code', 'name', 'company_name', 'business_style_id', 'tin',
  'payment_term_id', 'credit_limit', 'sales_division_id', 'default_sales_rep_id', 'is_active',
];

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, bs.name AS business_style_name, pt.term_name AS payment_term_name, sd.name AS sales_division_name
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
    const [[customer]] = await pool.query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!customer) return res.status(404).json({ error: 'Not found' });
    const [contacts] = await pool.query('SELECT * FROM customer_contacts WHERE customer_id = ? ORDER BY id', [req.params.id]);
    const [addresses] = await pool.query('SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY id', [req.params.id]);
    res.json({ ...customer, contacts, addresses });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const values = FIELDS.map((f) => (req.body[f] === undefined ? null : req.body[f]));
    const [result] = await conn.query(
      `INSERT INTO customers (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
      values
    );
    const customerId = result.insertId;

    for (const c of req.body.contacts || []) {
      await conn.query(
        `INSERT INTO customer_contacts (customer_id, contact_name, title, email, phone, description, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [customerId, c.contact_name, c.title || null, c.email || null, c.phone || null, c.description || null, !!c.is_primary]
      );
    }
    for (const a of req.body.addresses || []) {
      await conn.query(
        `INSERT INTO customer_addresses (customer_id, address_type, address_line, is_default) VALUES (?, ?, ?, ?)`,
        [customerId, a.address_type || 'Shipping', a.address_line, !!a.is_default]
      );
    }

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
  try {
    const values = FIELDS.map((f) => (req.body[f] === undefined ? null : req.body[f]));
    await pool.query(
      `UPDATE customers SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM customer_contacts WHERE customer_id = ?', [req.params.id]);
    await conn.query('DELETE FROM customer_addresses WHERE customer_id = ?', [req.params.id]);
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

// --- Contacts ---
router.post('/:id/contacts', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { contact_name, title, email, phone, description, is_primary } = req.body;
    const [result] = await pool.query(
      `INSERT INTO customer_contacts (customer_id, contact_name, title, email, phone, description, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, contact_name, title || null, email || null, phone || null, description || null, !!is_primary]
    );
    const [[row]] = await pool.query('SELECT * FROM customer_contacts WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
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
