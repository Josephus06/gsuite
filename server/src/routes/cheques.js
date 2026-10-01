const express = require('express');
const { missingDepartmentError } = require('../lib/requireDepartment');
const pool = require('../db');
const { assignDocNo } = require('../lib/docNumber');
const { requireAuth, requirePermission, isSystemAdmin, userCan } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { computeChequeGl, chequeCreditsByCheque } = require('../lib/glImpact');
const { postReversalJournal } = require('../lib/reversalJournal');

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

// The Payee is the linked vendor/customer/employee record; Payee Name is a separate free-typed
// field. Live prints both and they often differ (vendor YUTYCO, payee name the person who
// collected the cheque). Imported rows used to carry lower-case 'supplier'/'customer'/'employee'.
const PAYEE_ACCOUNT_NAME_SQL = `CASE
    WHEN c.payee_type IN ('VENDOR', 'supplier') THEN (SELECT s.name FROM suppliers s WHERE s.id = c.payee_id)
    WHEN c.payee_type IN ('CUSTOMER', 'customer') THEN (SELECT cu.name FROM customers cu WHERE cu.id = c.payee_id)
    WHEN c.payee_type IN ('EMPLOYEE', 'employee') THEN (SELECT CONCAT(e.first_name, ' ', e.last_name) FROM employees e WHERE e.id = c.payee_id)
  END`;

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
              coa.account_name, ${PAYEE_ACCOUNT_NAME_SQL} AS payee_account_name
       FROM cheques c LEFT JOIN chart_of_accounts coa ON coa.id = c.account_id
       ${whereSql} ORDER BY c.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- bill credits on a cheque
// A Cheque to a Vendor may use up that vendor's open Bill Credits (cheque_bill_credits): each takes
// its applied amount off the credit's remaining balance and off the cash the cheque pays, and posts
// CR the credit's AP account. Same bookkeeping as a Bill Payment's credit lines.

const isVendor = (t) => ['VENDOR', 'supplier'].includes(String(t || ''));
// Whose credit it is: the vendor on its bill (the PO's supplier where the bill came from one).
const CREDIT_SUPPLIER_SQL = `(SELECT COALESCE(po.supplier_id, vb.supplier_id) FROM vendor_bills vb
    LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id WHERE vb.id = bc.vendor_bill_id)`;

async function chequeCredits(db, chequeId) {
  return (await chequeCreditsByCheque([Number(chequeId)])).get(Number(chequeId)) || [];
}

// [{ bill_credit_id, applied_amount }] from the request, positive amounts only.
function normalizeCredits(credits) {
  return (Array.isArray(credits) ? credits : [])
    .map((c) => ({ bill_credit_id: Number(c.bill_credit_id), applied_amount: round2(c.applied_amount) }))
    .filter((c) => c.bill_credit_id && c.applied_amount > 0);
}

// Take the credits up: each must be the payee vendor's, open, and have that much left.
async function applyCredits(conn, chequeId, supplierId, credits) {
  for (const c of credits) {
    const [[bc]] = await conn.query(
      `SELECT bc.bill_credit_no, bc.total_amount, bc.applied_amount, bc.status, ${CREDIT_SUPPLIER_SQL} AS supplier_id
         FROM bill_credits bc WHERE bc.id = ? FOR UPDATE`, [c.bill_credit_id]);
    if (!bc || bc.status !== 'open') throw Object.assign(new Error('One of the selected bill credits is no longer open.'), { status: 400 });
    if (Number(bc.supplier_id) !== Number(supplierId)) throw Object.assign(new Error(`${bc.bill_credit_no} is not this vendor's credit.`), { status: 400 });
    const remaining = round2(Number(bc.total_amount) - Number(bc.applied_amount));
    if (c.applied_amount > remaining + 0.001) throw Object.assign(new Error(`${bc.bill_credit_no} has only ${remaining.toFixed(2)} left to apply.`), { status: 409 });
    await conn.query('UPDATE bill_credits SET applied_amount = applied_amount + ? WHERE id = ?', [c.applied_amount, c.bill_credit_id]);
    try {
      await conn.query('INSERT INTO cheque_bill_credits (cheque_id, bill_credit_id, applied_amount) VALUES (?, ?, ?)', [chequeId, c.bill_credit_id, c.applied_amount]);
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') throw Object.assign(new Error('Bill credits on cheques are not set up on this server yet (src/db/create-cheque-bill-credits.js).'), { status: 503 });
      throw e;
    }
  }
}

// Give a cheque's credits back (edit, void). Returns what it had taken.
async function releaseCredits(conn, chequeId) {
  let rows = [];
  try {
    [rows] = await conn.query('SELECT bill_credit_id, applied_amount FROM cheque_bill_credits WHERE cheque_id = ?', [chequeId]);
  } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return []; throw e; }
  for (const r of rows) await conn.query('UPDATE bill_credits SET applied_amount = GREATEST(applied_amount - ?, 0) WHERE id = ?', [Number(r.applied_amount), r.bill_credit_id]);
  await conn.query('DELETE FROM cheque_bill_credits WHERE cheque_id = ?', [chequeId]);
  return rows;
}

// Credits on a cheque must belong to a Vendor payee, and leave something to pay.
function creditsError(b, credits, t) {
  if (!credits.length) return null;
  if (!isVendor(b.payee_type) || !b.payee_id) return 'Bill credits can only be applied when the Payee is a Vendor.';
  const credit = round2(credits.reduce((s, c) => s + c.applied_amount, 0));
  if (credit >= round2(t.gross_amount - t.withholding_tax_amount)) return 'The bill credits applied must be less than the amount the cheque pays.';
  return null;
}

// The vendor's open credits for the form, with what THIS cheque already uses counted as available.
router.get('/vendor-credits', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const supplierId = Number(req.query.supplier_id);
    if (!supplierId) return res.json([]);
    const chequeId = Number(req.query.cheque_id) || 0;
    const mine = new Map();
    if (chequeId) for (const c of await chequeCredits(pool, chequeId)) mine.set(Number(c.bill_credit_id), Number(c.applied_amount));
    const [rows] = await pool.query(
      `SELECT bc.id AS bill_credit_id, bc.bill_credit_no, bc.date_created, bc.memo, bc.total_amount, bc.applied_amount
         FROM bill_credits bc
        WHERE ${CREDIT_SUPPLIER_SQL} = ? AND (bc.status = 'open' AND bc.applied_amount < bc.total_amount OR bc.id IN (?))
        ORDER BY bc.date_created, bc.id`, [supplierId, [...mine.keys(), 0]]);
    res.json(rows.map((r) => ({
      bill_credit_id: r.bill_credit_id, bill_credit_no: r.bill_credit_no, date_created: r.date_created, memo: r.memo,
      total_amount: Number(r.total_amount),
      remaining: round2(Number(r.total_amount) - Number(r.applied_amount) + (mine.get(Number(r.bill_credit_id)) || 0)),
      applied_amount: mine.get(Number(r.bill_credit_id)) || 0,
    })));
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[c]] = await pool.query(
      `SELECT c.*, coa.account_code, coa.account_name, loc.location_name,
              ${PAYEE_ACCOUNT_NAME_SQL} AS payee_account_name,
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
    //
    // Shown for voided cheques too. This tab documents what THIS cheque posted, and a void
    // does not un-post it: live keeps the original entries and reverses them with a separate
    // journal, which appears under Related Records. Blanking the tab on void hid the entries
    // for all 690 imported voided cheques even though their reversal is right there.
    // (The /void handler below now posts that reversal itself, so a cheque voided in-app reads
    // the same as an imported one -- it used to only flip the status, and the entry it left
    // behind had nothing reversing it.) The same function the ledger uses, bill credits included.
    const credits = await chequeCredits(pool, req.params.id);
    const gl = await computeChequeGl({ ...c, bank_code: c.account_code, bank_name: c.account_name }, lines, credits);
    res.json({ ...c, lines, credits, gl });
  } catch (err) { next(err); }
});

// The Payment Voucher and the BPI cheque face (client/src/pages/BillPaymentPrint.jsx, kind
// "cheque") -- the same two printouts as a Bill Payment. System Admin always; everyone else needs
// can_print on /cheques. A voided cheque still prints, marked VOID.
router.get('/:id/print', requireAuth, async (req, res, next) => {
  try {
    if (!(await isSystemAdmin(req.user.id)) && !(await userCan(req.user.id, ROUTE, 'can_print'))) {
      return res.status(403).json({ error: 'You do not have permission to print a Cheque.' });
    }
    const [[c]] = await pool.query(
      `SELECT c.*, coa.account_code AS bank_account_code, coa.account_name AS bank_account_name, loc.location_name,
              ${PAYEE_ACCOUNT_NAME_SQL} AS payee_account_name,
              u.display_name AS created_by_name, u.signature_data AS prepared_signature
         FROM cheques c
         LEFT JOIN chart_of_accounts coa ON coa.id = c.account_id
         LEFT JOIN locations loc ON loc.id = c.office_location_id
         LEFT JOIN users u ON u.id = c.created_by_user_id
        WHERE c.id = ?`, [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const [lines] = await pool.query(
      `SELECT cl.*, coa.account_code, coa.account_name, d.name AS department_name
         FROM cheque_lines cl
         LEFT JOIN chart_of_accounts coa ON coa.id = cl.account_id
         LEFT JOIN departments d ON d.id = cl.department_id
        WHERE cl.cheque_id = ? ORDER BY cl.line_no`, [req.params.id]);
    res.json({ ...c, lines, credits: await chequeCredits(pool, req.params.id) });
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

// total_amount is the cash the cheque pays: gross, less withholding, less any bill credits used.
function headerTotals(rows, credits = []) {
  const net = round2(rows.reduce((s, l) => s + l.amount, 0));
  const tax = round2(rows.reduce((s, l) => s + l.tax_amount, 0));
  const wtax = round2(rows.reduce((s, l) => s + l.withholding_tax_amount, 0));
  const gross = round2(net + tax);
  const credit = round2(credits.reduce((s, c) => s + c.applied_amount, 0));
  return { subtotal: net, net_of_tax: net, tax_amount: tax, withholding_tax_amount: wtax, gross_amount: gross, credit_amount: credit, total_amount: round2(gross - wtax - credit) };
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    const rows = normalizeLines(b.lines);
    if (!rows.length) return res.status(400).json({ error: 'Add at least one expense line with an account and amount.' });
    if (!b.account_id) return res.status(400).json({ error: 'Select the bank Account to draw the cheque against.' });
    const deptError = await missingDepartmentError(rows);
    if (deptError) return res.status(400).json({ error: deptError });
    const credits = normalizeCredits(b.credits);
    const t = headerTotals(rows, credits);
    const crError = creditsError(b, credits, t);
    if (crError) return res.status(400).json({ error: crError });
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
    const chequeNo = await assignDocNo(conn, { table: 'cheques', column: 'cheque_no', prefix: 'CHK-', id: chequeId });
    let lineNo = 0;
    for (const l of rows) {
      lineNo += 1;
      await conn.query(
        `INSERT INTO cheque_lines (cheque_id, line_no, account_id, department_id, description, amount, tax_code_id, tax_amount, apply_withholding_tax, withholding_tax_amount, gross_amount, total_amount)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [chequeId, lineNo, l.account_id, l.department_id, l.description, l.amount, l.tax_code_id, l.tax_amount, l.apply_withholding_tax, l.withholding_tax_amount, l.gross_amount, l.total_amount]
      );
    }
    await applyCredits(conn, chequeId, b.payee_id, credits);
    await logAudit(conn, { chequeId, userId: req.user.id, eventType: 'Created', fieldName: 'cheque_no', newValue: chequeNo });
    await conn.commit();
    res.status(201).json({ id: chequeId, cheque_no: chequeNo });
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { conn.release(); }
});

// Editing a saved cheque: header and expense lines rewritten, every change logged. The GL is
// derived from these rows (lib/glImpact.js), so nothing posted needs re-posting. A voided cheque
// is not editable -- its reversal journal was built from what it was. Once the bank statement is
// matched to it, its date, bank account and amount are fixed.
const CHEQUE_EDIT_FIELDS = ['date_created', 'payee_type', 'payee_id', 'payee_name', 'office_location_id', 'account_id',
  'cheque_date', 'cheque_number', 'date_released', 'currency', 'conversion_rate', 'memo'];
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    const [[c]] = await conn.query('SELECT * FROM cheques WHERE id = ?', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (c.status === 'void') return res.status(409).json({ error: 'This cheque is voided and cannot be edited.' });
    const rows = normalizeLines(b.lines);
    if (!rows.length) return res.status(400).json({ error: 'Add at least one expense line with an account and amount.' });
    if (!b.account_id) return res.status(400).json({ error: 'Select the bank Account to draw the cheque against.' });
    // Department is required on lines the edit adds or changes -- not on lines carried over as they
    // were: no migrated cheque has departments, and a memo fix must not demand them on every line.
    const lineKey = (l) => `${l.account_id}|${round2(l.amount)}|${l.description || ''}|${l.department_id || ''}`;
    const [existingLines] = await conn.query('SELECT account_id, amount, description, department_id FROM cheque_lines WHERE cheque_id = ?', [req.params.id]);
    const untouched = new Map();
    for (const l of existingLines) untouched.set(lineKey(l), (untouched.get(lineKey(l)) || 0) + 1);
    const toCheck = rows.map((l) => {
      const k = lineKey(l);
      if (untouched.get(k)) { untouched.set(k, untouched.get(k) - 1); return { ...l, department_id: l.department_id || -1 }; }
      return l;
    });
    const deptError = await missingDepartmentError(toCheck);
    if (deptError) return res.status(400).json({ error: deptError });
    // A request that does not mention credits keeps the ones the cheque has.
    const credits = b.credits === undefined
      ? normalizeCredits(await chequeCredits(conn, req.params.id))
      : normalizeCredits(b.credits);
    const t = headerTotals(rows, credits);
    const crError = creditsError(b, credits, t);
    if (crError) return res.status(400).json({ error: crError });
    const day = (v) => (v == null || v === '' ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));
    const next_ = {
      date_created: day(b.date_created) || day(c.date_created), payee_type: trunc(b.payee_type, 20), payee_id: b.payee_id || null,
      payee_name: trunc(b.payee_name, 255), office_location_id: b.office_location_id || null, account_id: b.account_id,
      cheque_date: day(b.cheque_date), cheque_number: trunc(b.cheque_number, 60), date_released: day(b.date_released),
      currency: trunc(b.currency, 10), conversion_rate: num(b.conversion_rate) || 1, memo: trunc(b.memo, 1000),
    };
    const [[m]] = await conn.query("SELECT COUNT(*) n FROM bank_reconciliation_matches WHERE source_kind = 'cheque' AND source_id = ?", [req.params.id]);
    if (Number(m.n) && (day(c.date_created) !== next_.date_created || Number(c.account_id) !== Number(next_.account_id)
        || Math.abs(Number(c.total_amount) - t.total_amount) > 0.005)) {
      return res.status(409).json({ error: 'This cheque is already matched on a bank reconciliation, so its date, bank account and amount cannot change. Unmatch it there first; the other fields can still be edited.' });
    }
    await assertPeriodOpen(c.date_created, 'other_gl', conn);
    await assertPeriodOpen(next_.date_created, 'other_gl', conn);

    await conn.beginTransaction();
    await conn.query(
      `UPDATE cheques SET ${CHEQUE_EDIT_FIELDS.map((f) => `${f} = ?`).join(', ')},
              subtotal = ?, net_of_tax = ?, tax_amount = ?, withholding_tax_amount = ?, gross_amount = ?, total_amount = ?
        WHERE id = ?`,
      [...CHEQUE_EDIT_FIELDS.map((f) => next_[f]), t.subtotal, t.net_of_tax, t.tax_amount, t.withholding_tax_amount, t.gross_amount, t.total_amount, req.params.id]);
    const [oldLines] = await conn.query('SELECT account_id, department_id, description, amount, tax_code_id, withholding_tax_amount FROM cheque_lines WHERE cheque_id = ? ORDER BY line_no', [req.params.id]);
    await conn.query('DELETE FROM cheque_lines WHERE cheque_id = ?', [req.params.id]);
    let lineNo = 0;
    for (const l of rows) {
      lineNo += 1;
      await conn.query(
        `INSERT INTO cheque_lines (cheque_id, line_no, account_id, department_id, description, amount, tax_code_id, tax_amount, apply_withholding_tax, withholding_tax_amount, gross_amount, total_amount)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id, lineNo, l.account_id, l.department_id, l.description, l.amount, l.tax_code_id, l.tax_amount, l.apply_withholding_tax, l.withholding_tax_amount, l.gross_amount, l.total_amount]);
    }
    // Bill credits: give back what it had, take up what it has now (checked against what is left).
    const oldCredits = await releaseCredits(conn, req.params.id);
    await applyCredits(conn, req.params.id, b.payee_id, credits);
    const csig = (cs) => cs.map((x) => `BC${x.bill_credit_id}:${Number(x.applied_amount).toFixed(2)}`).sort().join(', ');
    if (csig(oldCredits) !== csig(credits)) await logAudit(conn, { chequeId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'bill_credits', oldValue: csig(oldCredits) || null, newValue: csig(credits) || null });
    for (const f of CHEQUE_EDIT_FIELDS) {
      const was = f.includes('date') ? day(c[f]) : c[f];
      if (String(was ?? '') !== String(next_[f] ?? '')) await logAudit(conn, { chequeId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: f, oldValue: was, newValue: next_[f] });
    }
    const sig = (ls) => ls.map((l) => `${l.account_id}/${l.department_id || ''}:${Number(l.amount).toFixed(2)}${Number(l.withholding_tax_amount) ? ` wtax ${Number(l.withholding_tax_amount).toFixed(2)}` : ''}`).join('; ');
    if (sig(oldLines) !== sig(rows)) await logAudit(conn, { chequeId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'expense_lines', oldValue: sig(oldLines).slice(0, 1000), newValue: sig(rows).slice(0, 1000) });
    if (Math.abs(Number(c.total_amount) - t.total_amount) > 0.005) await logAudit(conn, { chequeId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'total_amount', oldValue: c.total_amount, newValue: t.total_amount });
    await conn.commit();
    res.json({ id: Number(req.params.id), cheque_no: c.cheque_no });
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { conn.release(); }
});

// Date Released on its own, editable at any time and on any cheque (the user's rule): the money
// is released after the cheque is written, and a wrong date must always be correctable.
router.put('/:id/date-released', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const raw = req.body.date_released;
    const dateReleased = raw === '' || raw == null ? null : String(raw).slice(0, 10);
    if (dateReleased && !/^\d{4}-\d{2}-\d{2}$/.test(dateReleased)) return res.status(400).json({ error: 'Date Released must be a date.' });
    const [[c]] = await conn.query('SELECT date_released FROM cheques WHERE id = ?', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    await conn.query('UPDATE cheques SET date_released = ? WHERE id = ?', [dateReleased, req.params.id]);
    const was = c.date_released ? String(c.date_released instanceof Date ? c.date_released.toISOString() : c.date_released).slice(0, 10) : null;
    if (was !== dateReleased) await logAudit(conn, { chequeId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'date_released', oldValue: was, newValue: dateReleased });
    res.json({ ok: true, date_released: dateReleased });
  } catch (err) { next(err); } finally { conn.release(); }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[c]] = await conn.query('SELECT status, date_created FROM cheques WHERE id = ?', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (c.status === 'void') return res.status(409).json({ error: 'Already voided.' });
    await assertPeriodOpen(c.date_created, 'other_gl', conn);
    await conn.beginTransaction();
    await conn.query("UPDATE cheques SET status = 'void', voided_at = NOW(), voided_by_user_id = ? WHERE id = ?", [req.user.id, req.params.id]);
    // The reversal the imported cheques always had, now written by the app that voids them rather
    // than only ever arriving from the live system. A void cheque keeps posting its own entry
    // (lib/glImpact.js) and this cancels it.
    const [[fullCheque]] = await conn.query(
      `SELECT c.*, coa.account_code AS bank_code, coa.account_name AS bank_name FROM cheques c
       LEFT JOIN chart_of_accounts coa ON coa.id = c.account_id WHERE c.id = ?`, [req.params.id]);
    const [chequeLines] = await conn.query(
      `SELECT cl.amount, cl.department_id, coa.account_code, coa.account_name
         FROM cheque_lines cl LEFT JOIN chart_of_accounts coa ON coa.id = cl.account_id
        WHERE cl.cheque_id = ? ORDER BY cl.line_no`, [req.params.id]);
    // Its bill credits are reversed with the rest of its entry and go back to the vendor. The
    // rows stay, so the voided cheque's GL Impact still shows what it had used.
    const credits = await chequeCredits(conn, req.params.id);
    for (const cr of credits) await conn.query('UPDATE bill_credits SET applied_amount = GREATEST(applied_amount - ?, 0) WHERE id = ?', [Number(cr.applied_amount), cr.bill_credit_id]);
    const reversal = await postReversalJournal(conn, {
      sourceType: 'cheque', sourceId: Number(req.params.id), sourceNo: fullCheque.cheque_no,
      glRows: await computeChequeGl(fullCheque, chequeLines, credits),
      documentDate: fullCheque.date_created, voidedAt: new Date(),
      reason: req.body?.reason || null, userId: req.user.id, locationId: fullCheque.office_location_id || null,
    });
    await logAudit(conn, { chequeId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: c.status, newValue: 'void' });
    if (reversal) {
      await logAudit(conn, {
        chequeId: req.params.id, userId: req.user.id, eventType: 'Created',
        fieldName: 'reversal_journal_no', newValue: reversal.journalNo,
      });
    }
    await conn.commit();
    res.json({ ok: true, reversal_journal_no: reversal?.journalNo || null });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
