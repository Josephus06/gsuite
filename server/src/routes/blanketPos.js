const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/estimates';

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const where = req.query.customer_id ? 'WHERE customer_id = ?' : '';
    const params = req.query.customer_id ? [req.query.customer_id] : [];
    const [rows] = await pool.query(`SELECT * FROM blanket_pos ${where} ORDER BY id DESC`, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const { customer_id, po_number, memo } = req.body;
    const [result] = await pool.query(
      'INSERT INTO blanket_pos (customer_id, po_number, memo) VALUES (?, ?, ?)',
      [customer_id, po_number, memo || null]
    );
    const [[row]] = await pool.query('SELECT * FROM blanket_pos WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM blanket_pos WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This blanket PO is referenced by an estimate and cannot be deleted.' });
    }
    next(err);
  }
});

module.exports = router;
