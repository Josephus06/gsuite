const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeCommissionVoucherGl } = require('../lib/glImpact');

const router = express.Router();
// Commission Voucher (COMVCH-####): the release/payment side of Commission Payable. Pays (full or
// partial) one or more of an employee's Commission Payables from a cash/bank account, optionally net
// of expense adjustments. Settling a payable advances its amount_paid and flips its status
// (partial / paid). Posts DR 24200 per commission released, +/- each expense by sign, CR the
// cash/bank account for the net Total Payments.
const ROUTE = '/commission-vouchers';
const round2 = (n) => Number((Number(n) || 0).toFixed(2));

async function logAudit(conn, { cvId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('CommissionVoucher', ?, ?, ?, ?, ?, ?)`,
    [cvId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Recompute a payable's status from its paid-vs-commissionable position.
function payableStatus(commissionable, paid) {
  const c = round2(commissionable); const p = round2(paid);
  if (p <= 0) return 'unpaid';
  if (p + 0.005 >= c) return 'paid';
  return 'partial';
}

// Employees who still have a releasable (unpaid/partial) commission payable.
router.get('/employees', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name, d.name AS department_name
       FROM commission_payables cp
       JOIN employees e ON e.id = cp.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE cp.status IN ('unpaid', 'partial')
       ORDER BY name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Powers the create form: an employee's releasable payables + the pickers (cash/bank accounts,
// payment methods, expense accounts).
router.get('/for-employee/:employeeId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[emp]] = await pool.query("SELECT id, CONCAT(first_name, ' ', last_name) AS name FROM employees WHERE id = ?", [req.params.employeeId]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const [payables] = await pool.query(
      `SELECT id AS commission_payable_id, commission_payable_no, date_created, period_from,
              commissionable_amount, amount_paid,
              ROUND(commissionable_amount - amount_paid, 2) AS balance_due
       FROM commission_payables
       WHERE employee_id = ? AND status IN ('unpaid', 'partial')
       ORDER BY period_from`,
      [req.params.employeeId]
    );
    const [cashAccounts] = await pool.query(
      "SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code LIKE '11%' AND account_type = 'Asset' AND is_active = TRUE ORDER BY account_code"
    );
    const [paymentMethods] = await pool.query('SELECT id, name FROM payment_methods ORDER BY name');
    const [expenseAccounts] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE is_active = TRUE ORDER BY account_code');

    res.json({ employee: emp, payables, cash_accounts: cashAccounts, payment_methods: paymentMethods, expense_accounts: expenseAccounts });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status } = req.query;
    const where = []; const params = [];
    if (status) { where.push('cv.status = ?'); params.push(status); }
    if (search) { where.push('(cv.voucher_no LIKE ? OR CONCAT(e.first_name, " ", e.last_name) LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT cv.id, cv.voucher_no, cv.date_created, cv.total_payments, cv.status, cv.payment_type,
              CONCAT(e.first_name, ' ', e.last_name) AS employee_name, pm.name AS payment_method_name
       FROM commission_vouchers cv
       LEFT JOIN employees e ON e.id = cv.employee_id
       LEFT JOIN payment_methods pm ON pm.id = cv.payment_method_id
       ${whereSql} ORDER BY cv.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[cv]] = await pool.query(
      `SELECT cv.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, pm.name AS payment_method_name,
              coa.account_code AS cash_account_code, coa.account_name AS cash_account_name, u.display_name AS created_by_name
       FROM commission_vouchers cv
       LEFT JOIN employees e ON e.id = cv.employee_id
       LEFT JOIN payment_methods pm ON pm.id = cv.payment_method_id
       LEFT JOIN chart_of_accounts coa ON coa.id = cv.cash_bank_account_id
       LEFT JOIN users u ON u.id = cv.created_by_user_id
       WHERE cv.id = ?`,
      [req.params.id]
    );
    if (!cv) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT cvl.*, cp.commission_payable_no, cp.date_created AS payable_date, cp.period_from
       FROM commission_voucher_lines cvl
       LEFT JOIN commission_payables cp ON cp.id = cvl.commission_payable_id
       WHERE cvl.commission_voucher_id = ? ORDER BY cp.period_from`,
      [req.params.id]
    );
    const [expenses] = await pool.query(
      `SELECT cve.*, coa.account_code, coa.account_name
       FROM commission_voucher_expenses cve LEFT JOIN chart_of_accounts coa ON coa.id = cve.account_id
       WHERE cve.commission_voucher_id = ?`,
      [req.params.id]
    );
    const glImpact = await computeCommissionVoucherGl(cv, lines, expenses);
    res.json({ ...cv, lines, expenses, gl_impact: glImpact });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'CommissionVoucher' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      employee_id: employeeId, date_created: dateCreated, payee_name: payeeName, reference_no: referenceNo,
      memo, payment_method_id: paymentMethodId, cash_bank_account_id: cashBankAccountId,
      payment_type: paymentType, date_released: dateReleased, lines, expenses,
    } = req.body;

    if (!employeeId) return res.status(400).json({ error: 'Employee is required.' });
    const releaseLines = (Array.isArray(lines) ? lines : []).filter((l) => l.commission_payable_id && Number(l.released_amount) > 0);
    if (!releaseLines.length) return res.status(400).json({ error: 'Release an amount for at least one commission.' });

    // Validate each payable belongs to the employee, isn't over-released.
    const prepared = [];
    for (const l of releaseLines) {
      const [[cp]] = await conn.query('SELECT id, commission_payable_no, employee_id, commissionable_amount, amount_paid, status FROM commission_payables WHERE id = ?', [l.commission_payable_id]);
      if (!cp) return res.status(400).json({ error: 'A selected commission is no longer valid.' });
      if (Number(cp.employee_id) !== Number(employeeId)) return res.status(400).json({ error: `${cp.commission_payable_no} does not belong to this employee.` });
      if (cp.status === 'void') return res.status(409).json({ error: `${cp.commission_payable_no} is void.` });
      const balance = round2(cp.commissionable_amount - cp.amount_paid);
      if (Number(l.released_amount) > balance + 0.005) {
        return res.status(409).json({ error: `Released amount for ${cp.commission_payable_no} (${l.released_amount}) exceeds its balance due (${balance}).` });
      }
      prepared.push({ cp, released: round2(l.released_amount) });
    }
    const preparedExpenses = (Array.isArray(expenses) ? expenses : [])
      .filter((e) => e.account_id && Number(e.amount) !== 0)
      .map((e) => ({ account_id: e.account_id, description: e.description || null, amount: round2(e.amount) }));

    const totalReleased = round2(prepared.reduce((s, p) => s + p.released, 0));
    const expSum = round2(preparedExpenses.reduce((s, e) => s + e.amount, 0));
    const totalPayments = round2(totalReleased + expSum);

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO commission_vouchers
         (voucher_no, date_created, employee_id, payee_name, reference_no, memo, payment_method_id,
          cash_bank_account_id, payment_type, date_released, total_payments, status, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?)`,
      [dateCreated || new Date().toISOString().slice(0, 10), employeeId, payeeName || null, referenceNo || null, memo || null,
       paymentMethodId || null, cashBankAccountId || null, paymentType || 'full', dateReleased || null, totalPayments, req.user.id]
    );
    const cvId = result.insertId;
    await conn.query('UPDATE commission_vouchers SET voucher_no = ? WHERE id = ?', [`COMVCH-${cvId}`, cvId]);

    for (const { cp, released } of prepared) {
      await conn.query('INSERT INTO commission_voucher_lines (commission_voucher_id, commission_payable_id, released_amount) VALUES (?, ?, ?)', [cvId, cp.id, released]);
      // Settle the payable: advance amount_paid, flip status.
      const newPaid = round2(Number(cp.amount_paid) + released);
      await conn.query('UPDATE commission_payables SET amount_paid = ?, status = ?, updated_at = NOW() WHERE id = ?',
        [newPaid, payableStatus(cp.commissionable_amount, newPaid), cp.id]);
    }
    for (const e of preparedExpenses) {
      await conn.query('INSERT INTO commission_voucher_expenses (commission_voucher_id, account_id, description, amount) VALUES (?, ?, ?, ?)', [cvId, e.account_id, e.description, e.amount]);
    }
    await logAudit(conn, { cvId, userId: req.user.id, eventType: 'Created', fieldName: 'voucher_no', newValue: `COMVCH-${cvId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM commission_vouchers WHERE id = ?', [cvId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { conn.release(); }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[cv]] = await conn.query('SELECT status FROM commission_vouchers WHERE id = ?', [req.params.id]);
    if (!cv) return res.status(404).json({ error: 'Not found' });
    if (cv.status === 'void') return res.status(409).json({ error: 'This Commission Voucher is already void.' });

    await conn.beginTransaction();
    // Reverse the settlement: pull each released amount back off its payable.
    const [lines] = await conn.query('SELECT * FROM commission_voucher_lines WHERE commission_voucher_id = ?', [req.params.id]);
    for (const l of lines) {
      const [[cp]] = await conn.query('SELECT commissionable_amount, amount_paid FROM commission_payables WHERE id = ?', [l.commission_payable_id]);
      if (!cp) continue;
      const newPaid = round2(Number(cp.amount_paid) - Number(l.released_amount));
      await conn.query('UPDATE commission_payables SET amount_paid = ?, status = ?, updated_at = NOW() WHERE id = ?',
        [newPaid, payableStatus(cp.commissionable_amount, newPaid), l.commission_payable_id]);
    }
    await conn.query("UPDATE commission_vouchers SET status = 'void', voided_by_user_id = ?, voided_at = NOW() WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { cvId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: cv.status, newValue: 'void' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM commission_vouchers WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
