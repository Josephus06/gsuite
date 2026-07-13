const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/chart-of-account-types';

async function logAudit(conn, { typeId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('ChartOfAccountType', ?, ?, ?, ?, ?, ?)`,
    [typeId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search } = req.query;
    const where = [];
    const params = [];
    if (search) {
      where.push('(account_type LIKE ? OR account_sub_type LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT * FROM chart_of_account_types ${whereSql} ORDER BY account_type, account_sub_type`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM chart_of_account_types WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
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
       WHERE a.auditable_type = 'ChartOfAccountType' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const { account_type: accountType, account_sub_type: accountSubType, normal_balance: normalBalance } = req.body;
    const [result] = await pool.query(
      'INSERT INTO chart_of_account_types (account_type, account_sub_type, normal_balance) VALUES (?, ?, ?)',
      [accountType, accountSubType, normalBalance]
    );
    const [[row]] = await pool.query('SELECT * FROM chart_of_account_types WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This Account Type / Sub-Type pair already exists.' });
    next(err);
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[before]] = await conn.query('SELECT * FROM chart_of_account_types WHERE id = ?', [req.params.id]);
    if (!before) return res.status(404).json({ error: 'Not found' });

    const { account_type: accountType, account_sub_type: accountSubType, normal_balance: normalBalance } = req.body;
    await conn.beginTransaction();
    await conn.query(
      'UPDATE chart_of_account_types SET account_type = ?, account_sub_type = ?, normal_balance = ?, updated_at = NOW() WHERE id = ?',
      [accountType, accountSubType, normalBalance, req.params.id]
    );
    if (before.normal_balance !== normalBalance) {
      await logAudit(conn, { typeId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'normal_balance', oldValue: before.normal_balance, newValue: normalBalance });
    }
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM chart_of_account_types WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This Account Type / Sub-Type pair already exists.' });
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM chart_of_account_types WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This account type is referenced by existing accounts and cannot be deleted.' });
    }
    next(err);
  }
});

module.exports = router;
