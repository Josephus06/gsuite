const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
// Transaction Settings: the master list of transaction types with an "Is Posting" flag (whether the
// transaction posts to the ledger) and a display sequence. A configuration/reference list.
const ROUTE = '/transaction-settings';

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, transaction_name, is_posting, seq FROM transaction_settings ORDER BY seq, id');
    res.json(rows);
  } catch (err) { next(err); }
});

// Toggle a transaction type's is_posting flag.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    if (req.body.is_posting === undefined) return res.status(400).json({ error: 'Nothing to update.' });
    const [r] = await pool.query(
      'UPDATE transaction_settings SET is_posting = ?, updated_at = NOW(), updated_by_user_id = ? WHERE id = ?',
      [req.body.is_posting ? 1 : 0, req.user.id, req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    const [[row]] = await pool.query('SELECT id, transaction_name, is_posting, seq FROM transaction_settings WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) { next(err); }
});

module.exports = router;
