const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/chart-of-accounts';

const ENUM_MAP = {
  ASSET: 'Asset',
  LIABILITY: 'Liability',
  EQUITY: 'Equity',
  INCOME: 'Revenue',
  EXPENSE: 'Expense',
};

async function logAudit(conn, { accountId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('ChartOfAccount', ?, ?, ?, ?, ?, ?)`,
    [accountId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, page = '1', limit = '10' } = req.query;
    const where = [];
    const params = [];
    if (search) {
      where.push('(coa.account_code LIKE ? OR coa.account_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM chart_of_accounts coa ${whereSql}`,
      params
    );

    const pageNum = Math.max(1, Number(page) || 1);
    // Capped at 500, not the usual 100 -- EntityPicker fields (e.g. Parent Account on
    // the Add/Edit form) need the full list in one call, and the real chart currently
    // has 276 accounts.
    const limitNum = Math.min(500, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.query(
      `SELECT coa.*, ct.account_type AS coa_account_type, ct.account_sub_type
       FROM chart_of_accounts coa
       LEFT JOIN chart_of_account_types ct ON ct.id = coa.coa_type_id
       ${whereSql}
       ORDER BY coa.account_code
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({ rows, total, page: pageNum, limit: limitNum });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT coa.*, ct.account_type AS coa_account_type, ct.account_sub_type, ct.normal_balance,
              p.account_code AS parent_account_code, p.account_name AS parent_account_name
       FROM chart_of_accounts coa
       LEFT JOIN chart_of_account_types ct ON ct.id = coa.coa_type_id
       LEFT JOIN chart_of_accounts p ON p.id = coa.parent_account_id
       WHERE coa.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    const [children] = await pool.query(
      'SELECT id, account_code, account_name FROM chart_of_accounts WHERE parent_account_id = ? ORDER BY account_code',
      [req.params.id]
    );

    res.json({ ...row, children });
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
       WHERE a.auditable_type = 'ChartOfAccount' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

async function resolveLegacyType(conn, coaTypeId) {
  if (!coaTypeId) return 'Expense';
  const [[t]] = await conn.query('SELECT account_type FROM chart_of_account_types WHERE id = ?', [coaTypeId]);
  return ENUM_MAP[t?.account_type] || 'Expense';
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      account_code: accountCode, account_name: accountName, coa_type_id: coaTypeId,
      parent_account_id: parentAccountId, description, detail_type: detailType,
      is_summary: isSummary, is_active: isActive,
    } = req.body;

    const legacyType = await resolveLegacyType(conn, coaTypeId);
    const [result] = await conn.query(
      `INSERT INTO chart_of_accounts
         (account_code, account_name, account_type, coa_type_id, parent_account_id, description, detail_type, is_summary, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountCode, accountName, legacyType, coaTypeId || null, parentAccountId || null, description || null, detailType || null, !!isSummary, isActive === undefined ? true : !!isActive]
    );
    const [[row]] = await pool.query('SELECT * FROM chart_of_accounts WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Account Code already in use' });
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[before]] = await conn.query('SELECT * FROM chart_of_accounts WHERE id = ?', [req.params.id]);
    if (!before) return res.status(404).json({ error: 'Not found' });

    const {
      account_code: accountCode, account_name: accountName, coa_type_id: coaTypeId,
      parent_account_id: parentAccountId, description, detail_type: detailType,
      is_summary: isSummary, is_active: isActive,
    } = req.body;

    if (parentAccountId && Number(parentAccountId) === Number(req.params.id)) {
      return res.status(400).json({ error: 'An account cannot be its own parent.' });
    }

    const legacyType = await resolveLegacyType(conn, coaTypeId);
    await conn.beginTransaction();
    await conn.query(
      `UPDATE chart_of_accounts SET account_code = ?, account_name = ?, account_type = ?, coa_type_id = ?,
              parent_account_id = ?, description = ?, detail_type = ?, is_summary = ?, is_active = ?, updated_at = NOW()
       WHERE id = ?`,
      [accountCode, accountName, legacyType, coaTypeId || null, parentAccountId || null, description || null, detailType || null, !!isSummary, isActive === undefined ? true : !!isActive, req.params.id]
    );
    if (String(before.is_active) !== String(!!isActive)) {
      await logAudit(conn, { accountId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'is_active', oldValue: before.is_active, newValue: !!isActive });
    }
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM chart_of_accounts WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Account Code already in use' });
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM chart_of_accounts WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This account is referenced by other data and cannot be deleted.' });
    }
    next(err);
  }
});

module.exports = router;
