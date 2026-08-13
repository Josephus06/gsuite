const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');

const router = express.Router();
// Cheque (CHK-####): pays a payee for expense lines, drawn against a bank account. GL: DR each
// expense account (+ VAT input 14300 on tax) / CR Expanded Withholding Tax (21402) for any withheld
// / CR the bank account for the net cash paid.
const ROUTE = '/cheques';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (v) => Number(num(v).toFixed(2));
const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));

async function logAudit(conn, { chequeId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('Cheque', ?, ?, ?, ?, ?, ?)`,
    [chequeId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId]
  );
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [bankAccounts] = await pool.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE detail_type = 'Bank' ORDER BY account_code");
    // Expense/posting accounts = non-summary (is_active unreliable in the migrated COA -- see Journal).
    const [accounts] = await pool.query('SELECT id, account_code, account_name, account_type FROM chart_of_accounts WHERE (is_summary = 0 OR is_summary IS NULL) ORDER BY account_code');
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    const [locations] = await pool.query('SELECT id, location_name FROM locations ORDER BY location_name');
    const [vendors] = await pool.query('SELECT id, name FROM suppliers WHERE is_active = TRUE ORDER BY name');
    const [customers] = await pool.query('SELECT id, name FROM customers ORDER BY name');
    const [employees] = await pool.query("SELECT id, CONCAT(first_name, ' ', last_name) AS name FROM employees WHERE is_active = TRUE ORDER BY first_name, last_name");
    const [taxes] = await pool.query('SELECT id, code, rate FROM taxes ORDER BY code');
    res.json({ bankAccounts, accounts, departments, locations, vendors, customers, employees, taxes });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status, as_of: asOf } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('c.status = ?'); params.push(status); }
    if (asOf) { where.push('c.date_created <= ?'); params.push(asOf); }
    if (search) { where.push('(c.cheque_no LIKE ? OR c.payee_name LIKE ? OR c.cheque_number LIKE ? OR c.memo LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT c.id, c.cheque_no, c.date_created, c.cheque_date, c.cheque_number, c.payee_name, c.total_amount, c.status, c.memo,
              coa.account_name
       FROM cheques c LEFT JOIN chart_of_accounts coa ON coa.id = c.account_id
       ${whereSql} ORDER BY c.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

function computeGl(cheque, lines) {
  // DR each expense account for its net amount; VAT input on any tax; CR 21402 for withholding;
  // CR the bank account for the total cash paid.
  const rows = [];
  for (const l of lines) {
    if (num(l.amount)) rows.push({ account_code: l.account_code, account_name: l.account_name, debit: round2(l.amount), credit: 0, department_id: l.department_id || null });
  }
  return rows; // tax/wtax/bank legs appended by the caller (which has the fixed accounts)
}

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[c]] = await pool.query(
      `SELECT c.*, coa.account_code, coa.account_name, loc.location_name,
              CONCAT(u.display_name) AS created_by_name
       FROM cheques c
       LEFT JOIN chart_of_accounts coa ON coa.id = c.account_id
       LEFT JOIN locations loc ON loc.id = c.office_location_id
       LEFT JOIN users u ON u.id = c.created_by_user_id
       WHERE c.id = ?`,
      [req.params.id]
    );
    if (!c) return res.status(404).json({ error: 'Not found' });
    const [lines] = await pool.query(
      `SELECT cl.*, coa.account_code, coa.account_name, d.name AS department_name, t.code AS tax_code
       FROM cheque_lines cl
       LEFT JOIN chart_of_accounts coa ON coa.id = cl.account_id
       LEFT JOIN departments d ON d.id = cl.department_id
       LEFT JOIN taxes t ON t.id = cl.tax_code_id
       WHERE cl.cheque_id = ? ORDER BY cl.line_no`,
      [req.params.id]
    );

    // GL Impact (matches the live tab): DR expenses (+VAT input) / CR EWT / CR bank.
    let gl = [];
    if (c.status !== 'void') {
      gl = computeGl(c, lines);
      const tax = round2(c.tax_amount);
      const wtax = round2(c.withholding_tax_amount);
      const total = round2(c.total_amount);
      if (tax) { const [[v]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '14300'"); if (v) gl.push({ account_code: v.account_code, account_name: v.account_name, debit: tax, credit: 0 }); }
      if (wtax) { const [[w]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '21402'"); if (w) gl.push({ account_code: w.account_code, account_name: w.account_name, debit: 0, credit: wtax }); }
      if (total && c.account_code) gl.push({ account_code: c.account_code, account_name: c.account_name, debit: 0, credit: total });
    }
    res.json({ ...c, lines, gl });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'Cheque' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Related Records: the journals raised against this cheque -- in practice the REVERSAL
// journal posted when it was voided. Live keeps no foreign key for this; the link is
// reconstructed at import time from the reversal's memo ("Voided from CHK-####") into
// journals.source_type/source_id, which is what this reads.
router.get('/:id/related', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT j.id, j.journal_no, j.date_created, j.status, j.memo, j.total_debit AS amount
         FROM journals j
        WHERE j.source_type = 'cheque' AND j.source_id = ?
        ORDER BY j.date_created DESC, j.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

function normalizeLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .filter((l) => l.account_id && (num(l.amount) !== 0 || num(l.tax_amount) !== 0))
    .map((l) => {
      const amount = round2(l.amount);
      const taxAmount = round2(l.tax_amount);
      const wtax = round2(l.withholding_tax_amount);
      const gross = round2(amount + taxAmount);
      return {
        account_id: l.account_id, department_id: l.department_id || null, description: trunc(l.description, 500),
        amount, tax_code_id: l.tax_code_id || null, tax_amount: taxAmount,
        apply_withholding_tax: l.apply_withholding_tax ? 1 : 0, withholding_tax_amount: wtax,
        gross_amount: gross, total_amount: round2(gross - wtax),
      };
    });
}

function headerTotals(rows) {
  const net = round2(rows.reduce((s, l) => s + l.amount, 0));
  const tax = round2(rows.reduce((s, l) => s + l.tax_amount, 0));
  const wtax = round2(rows.reduce((s, l) => s + l.withholding_tax_amount, 0));
  const gross = round2(net + tax);
  return { subtotal: net, net_of_tax: net, tax_amount: tax, withholding_tax_amount: wtax, gross_amount: gross, total_amount: round2(gross - wtax) };
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    const rows = normalizeLines(b.lines);
    if (!rows.length) return res.status(400).json({ error: 'Add at least one expense line with an account and amount.' });
    if (!b.account_id) return res.status(400).json({ error: 'Select the bank Account to draw the cheque against.' });
    const t = headerTotals(rows);
    await assertPeriodOpen(b.date_created, 'other_gl');

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO cheques (cheque_no, date_created, payee_type, payee_id, payee_name, office_location_id, account_id,
         cheque_date, cheque_number, date_released, currency, conversion_rate, memo,
         subtotal, discount_amount, net_of_tax, tax_amount, withholding_tax_amount, gross_amount, total_amount, status, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'open', ?)`,
      [b.date_created || new Date().toISOString().slice(0, 10), trunc(b.payee_type, 20), b.payee_id || null, trunc(b.payee_name, 255),
       b.office_location_id || null, b.account_id, b.cheque_date || null, trunc(b.cheque_number, 60), b.date_released || null,
       trunc(b.currency, 10), num(b.conversion_rate) || 1, trunc(b.memo, 1000),
       t.subtotal, t.net_of_tax, t.tax_amount, t.withholding_tax_amount, t.gross_amount, t.total_amount, req.user.id]
    );
    const chequeId = r.insertId;
    const chequeNo = `CHK-${chequeId}`;
    await conn.query('UPDATE cheques SET cheque_no = ? WHERE id = ?', [chequeNo, chequeId]);
    let lineNo = 0;
    for (const l of rows) {
      lineNo += 1;
      await conn.query(
        `INSERT INTO cheque_lines (cheque_id, line_no, account_id, department_id, description, amount, tax_code_id, tax_amount, apply_withholding_tax, withholding_tax_amount, gross_amount, total_amount)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [chequeId, lineNo, l.account_id, l.department_id, l.description, l.amount, l.tax_code_id, l.tax_amount, l.apply_withholding_tax, l.withholding_tax_amount, l.gross_amount, l.total_amount]
      );
    }
    await logAudit(conn, { chequeId, userId: req.user.id, eventType: 'Created', fieldName: 'cheque_no', newValue: chequeNo });
    await conn.commit();
    res.status(201).json({ id: chequeId, cheque_no: chequeNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[c]] = await conn.query('SELECT status, date_created FROM cheques WHERE id = ?', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (c.status === 'void') return res.status(409).json({ error: 'Already voided.' });
    await assertPeriodOpen(c.date_created, 'other_gl', conn);
    await conn.beginTransaction();
    await conn.query("UPDATE cheques SET status = 'void', voided_at = NOW(), voided_by_user_id = ? WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { chequeId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: c.status, newValue: 'void' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
