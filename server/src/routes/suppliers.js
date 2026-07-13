const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/suppliers';

const FIELDS = ['supplier_code', 'name', 'company_name', 'tin', 'payment_term_id', 'is_active'];

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.*, pt.term_name AS payment_term_name
       FROM suppliers s
       LEFT JOIN payment_terms pt ON pt.id = s.payment_term_id
       ORDER BY s.id DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[supplier]] = await pool.query('SELECT * FROM suppliers WHERE id = ?', [req.params.id]);
    if (!supplier) return res.status(404).json({ error: 'Not found' });
    const [contacts] = await pool.query('SELECT * FROM supplier_contacts WHERE supplier_id = ? ORDER BY id', [req.params.id]);
    const [addresses] = await pool.query('SELECT * FROM supplier_addresses WHERE supplier_id = ? ORDER BY id', [req.params.id]);
    res.json({ ...supplier, contacts, addresses });
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
      `INSERT INTO suppliers (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
      values
    );
    const supplierId = result.insertId;

    for (const c of req.body.contacts || []) {
      await conn.query(
        `INSERT INTO supplier_contacts (supplier_id, contact_name, title, email, phone, is_primary) VALUES (?, ?, ?, ?, ?, ?)`,
        [supplierId, c.contact_name, c.title || null, c.email || null, c.phone || null, !!c.is_primary]
      );
    }
    for (const a of req.body.addresses || []) {
      await conn.query(
        `INSERT INTO supplier_addresses (supplier_id, address_line, is_default) VALUES (?, ?, ?)`,
        [supplierId, a.address_line, !!a.is_default]
      );
    }

    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM suppliers WHERE id = ?', [supplierId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Supplier code already in use' });
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const values = FIELDS.map((f) => (req.body[f] === undefined ? null : req.body[f]));
    await pool.query(
      `UPDATE suppliers SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM suppliers WHERE id = ?', [req.params.id]);
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
    await conn.query('DELETE FROM supplier_contacts WHERE supplier_id = ?', [req.params.id]);
    await conn.query('DELETE FROM supplier_addresses WHERE supplier_id = ?', [req.params.id]);
    await conn.query('DELETE FROM suppliers WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This supplier is referenced by other data and cannot be deleted.' });
    }
    next(err);
  } finally {
    conn.release();
  }
});

router.post('/:id/contacts', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { contact_name, title, email, phone, is_primary } = req.body;
    const [result] = await pool.query(
      `INSERT INTO supplier_contacts (supplier_id, contact_name, title, email, phone, is_primary) VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, contact_name, title || null, email || null, phone || null, !!is_primary]
    );
    const [[row]] = await pool.query('SELECT * FROM supplier_contacts WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/contacts/:contactId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM supplier_contacts WHERE id = ? AND supplier_id = ?', [req.params.contactId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/addresses', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { address_line, is_default } = req.body;
    const [result] = await pool.query(
      `INSERT INTO supplier_addresses (supplier_id, address_line, is_default) VALUES (?, ?, ?)`,
      [req.params.id, address_line, !!is_default]
    );
    const [[row]] = await pool.query('SELECT * FROM supplier_addresses WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/addresses/:addressId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM supplier_addresses WHERE id = ? AND supplier_id = ?', [req.params.addressId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
