const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');

const router = express.Router();
// Fund Transfer (FT-####): moves an amount from one bank account to another. GL: DR the To account
// / CR the From account.
const ROUTE = '/fund-transfers';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (v) => Number(num(v).toFixed(2));
const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));

async function logAudit(conn, { ftId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('FundTransfer', ?, ?, ?, ?, ?, ?)`,
    [ftId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId]
  );
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [accounts] = await pool.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE detail_type = 'Bank' ORDER BY account_code");
    res.json({ accounts });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status, as_of: asOf } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('ft.status = ?'); params.push(status); }
    if (asOf) { where.push('ft.date_created <= ?'); params.push(asOf); }
    if (search) { where.push('(ft.ft_no LIKE ? OR ft.memo LIKE ? OR fa.account_name LIKE ? OR ta.account_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT ft.id, ft.ft_no, ft.date_created, ft.amount, ft.status, ft.memo,
              fa.account_name AS from_account_name, ta.account_name AS to_account_name,
              u.display_name AS prepared_by_name
       FROM fund_transfers ft
       LEFT JOIN chart_of_accounts fa ON fa.id = ft.from_account_id
       LEFT JOIN chart_of_accounts ta ON ta.id = ft.to_account_id
       LEFT JOIN users u ON u.id = ft.created_by_user_id
       ${whereSql} ORDER BY ft.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[ft]] = await pool.query(
      `SELECT ft.*, fa.account_code AS from_account_code, fa.account_name AS from_account_name,
              ta.account_code AS to_account_code, ta.account_name AS to_account_name,
              u.display_name AS prepared_by_name
       FROM fund_transfers ft
       LEFT JOIN chart_of_accounts fa ON fa.id = ft.from_account_id
       LEFT JOIN chart_of_accounts ta ON ta.id = ft.to_account_id
       LEFT JOIN users u ON u.id = ft.created_by_user_id
       WHERE ft.id = ?`,
      [req.params.id]
    );
    if (!ft) return res.status(404).json({ error: 'Not found' });
    // GL Impact: DR the To account / CR the From account for the amount.
    const amt = round2(ft.amount);
    const gl = (ft.status !== 'void' && amt > 0) ? [
      { account_code: ft.to_account_code, account_name: ft.to_account_name, debit: amt, credit: 0 },
      { account_code: ft.from_account_code, account_name: ft.from_account_name, debit: 0, credit: amt },
    ] : [];
    res.json({ ...ft, gl });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'FundTransfer' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { date_created: dateCreated, from_account_id: fromId, to_account_id: toId, amount, memo } = req.body;
    if (!fromId || !toId) return res.status(400).json({ error: 'Select both a From and a To account.' });
    if (String(fromId) === String(toId)) return res.status(400).json({ error: 'From and To accounts must be different.' });
    if (round2(amount) <= 0) return res.status(400).json({ error: 'Enter an amount greater than 0.' });
    await assertPeriodOpen(dateCreated, 'other_gl');

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO fund_transfers (ft_no, date_created, from_account_id, to_account_id, amount, memo, status, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, 'open', ?)`,
      [dateCreated || new Date().toISOString().slice(0, 10), fromId, toId, round2(amount), trunc(memo, 1000), req.user.id]
    );
    const ftId = r.insertId;
    const ftNo = `FT-${ftId}`;
    await conn.query('UPDATE fund_transfers SET ft_no = ? WHERE id = ?', [ftNo, ftId]);
    await logAudit(conn, { ftId, userId: req.user.id, eventType: 'Created', fieldName: 'ft_no', newValue: ftNo });
    await conn.commit();
    res.status(201).json({ id: ftId, ft_no: ftNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[ft]] = await conn.query('SELECT status, date_created FROM fund_transfers WHERE id = ?', [req.params.id]);
    if (!ft) return res.status(404).json({ error: 'Not found' });
    if (ft.status === 'void') return res.status(409).json({ error: 'Already voided.' });
    await assertPeriodOpen(ft.date_created, 'other_gl', conn);
    await conn.beginTransaction();
    await conn.query("UPDATE fund_transfers SET status = 'void', voided_at = NOW(), voided_by_user_id = ? WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { ftId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: ft.status, newValue: 'void' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
