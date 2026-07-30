const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');

const router = express.Router();
// Bank Deposit (BD-####): deposits one or more NOT-DEPOSITED customer payments into a bank account.
// DR <bank account> / CR 10006 Undeposited Funds for the total. Each payment links via
// customer_payments.deposit_id and flips to 'deposited'.
const ROUTE = '/deposits';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (v) => Number(num(v).toFixed(2));
const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));

async function logAudit(conn, { depositId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('BankDeposit', ?, ?, ?, ?, ?, ?)`,
    [depositId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId]
  );
}

// Lookups for the create form: bank accounts (COA detail_type 'Bank') + not-yet-deposited payments.
router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [accounts] = await pool.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE detail_type = 'Bank' ORDER BY account_code");
    const [payments] = await pool.query(
      `SELECT cp.id, cp.customer_payment_no, cp.date_created, cp.payment_amount,
              c.name AS customer_name, loc.location_name, pm.name AS payment_method_name
       FROM customer_payments cp
       LEFT JOIN customers c ON c.id = cp.customer_id
       LEFT JOIN locations loc ON loc.id = cp.office_location_id
       LEFT JOIN payment_methods pm ON pm.id = cp.payment_method_id
       WHERE cp.status = 'not_deposited' AND cp.deposit_id IS NULL ORDER BY cp.id DESC LIMIT 1000`
    );
    res.json({ accounts, payments });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status, as_of: asOf } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('d.status = ?'); params.push(status); }
    if (asOf) { where.push('d.date_created <= ?'); params.push(asOf); }
    if (search) { where.push('(d.bd_no LIKE ? OR d.memo LIKE ? OR coa.account_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT d.id, d.bd_no, d.date_created, d.total_amount, d.status, d.memo, coa.account_name
       FROM bank_deposits d LEFT JOIN chart_of_accounts coa ON coa.id = d.account_id
       ${whereSql} ORDER BY d.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[d]] = await pool.query(
      `SELECT d.*, coa.account_code, coa.account_name FROM bank_deposits d
       LEFT JOIN chart_of_accounts coa ON coa.id = d.account_id WHERE d.id = ?`,
      [req.params.id]
    );
    if (!d) return res.status(404).json({ error: 'Not found' });
    const [payments] = await pool.query(
      `SELECT cp.id, cp.customer_payment_no, cp.date_created, cp.payment_amount, c.name AS customer_name
       FROM customer_payments cp LEFT JOIN customers c ON c.id = cp.customer_id
       WHERE cp.deposit_id = ? ORDER BY cp.id`,
      [req.params.id]
    );
    // GL Impact: DR the bank account / CR 10006 Undeposited Funds for the total.
    const [[uf]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '10006'");
    const total = round2(d.total_amount);
    const gl = (d.status !== 'void' && total > 0) ? [
      { account_code: d.account_code, account_name: d.account_name, debit: total, credit: 0 },
      { account_code: uf?.account_code || '10006', account_name: uf?.account_name || 'Undeposited Funds', debit: 0, credit: total },
    ] : [];
    res.json({ ...d, payments, gl });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'BankDeposit' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { date_created: dateCreated, account_id: accountId, memo, payment_ids: paymentIds } = req.body;
    if (!accountId) return res.status(400).json({ error: 'Select a bank account to deposit into.' });
    const ids = [...new Set((Array.isArray(paymentIds) ? paymentIds : []).map(Number).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ error: 'Select at least one payment to deposit.' });

    const [pays] = await conn.query(
      "SELECT id, payment_amount, status, deposit_id FROM customer_payments WHERE id IN (?)", [ids]
    );
    if (pays.length !== ids.length) return res.status(400).json({ error: 'One or more payments are no longer valid.' });
    for (const p of pays) {
      if (p.deposit_id || p.status === 'deposited') return res.status(409).json({ error: 'One or more payments are already deposited.' });
      if (p.status === 'voided') return res.status(409).json({ error: 'A voided payment cannot be deposited.' });
    }
    const total = round2(pays.reduce((s, p) => s + num(p.payment_amount), 0));
    await assertPeriodOpen(dateCreated, 'ar');

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO bank_deposits (bd_no, date_created, account_id, memo, total_amount, status, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, 'open', ?)`,
      [dateCreated || new Date().toISOString().slice(0, 10), accountId, trunc(memo, 1000), total, req.user.id]
    );
    const depositId = r.insertId;
    const bdNo = `BD-${depositId}`;
    await conn.query('UPDATE bank_deposits SET bd_no = ? WHERE id = ?', [bdNo, depositId]);
    await conn.query("UPDATE customer_payments SET deposit_id = ?, status = 'deposited' WHERE id IN (?)", [depositId, ids]);
    await logAudit(conn, { depositId, userId: req.user.id, eventType: 'Created', fieldName: 'bd_no', newValue: bdNo });
    await conn.commit();
    res.status(201).json({ id: depositId, bd_no: bdNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[d]] = await conn.query('SELECT status, date_created FROM bank_deposits WHERE id = ?', [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    if (d.status === 'void') return res.status(409).json({ error: 'Already voided.' });
    await assertPeriodOpen(d.date_created, 'ar', conn);
    await conn.beginTransaction();
    // Release the payments back to not-deposited so they can be deposited again.
    await conn.query("UPDATE customer_payments SET deposit_id = NULL, status = 'not_deposited' WHERE deposit_id = ?", [req.params.id]);
    await conn.query("UPDATE bank_deposits SET status = 'void', voided_at = NOW(), voided_by_user_id = ? WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { depositId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: d.status, newValue: 'void' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
