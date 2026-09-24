const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { depositGlRows } = require('../lib/depositGl');

const router = express.Router();
// Bank Deposit (BD-####): deposits one or more NOT-DEPOSITED customer payments into a bank account,
// plus Other Deposit lines (money in no payment explains -- ADDED to the total) and Cash Back lines
// (cash kept back instead of banked -- DEDUCTED from it). total_amount is the net that reaches the
// bank. Each payment links via customer_payments.deposit_id and flips to 'deposited'. GL Impact is
// lib/depositGl.js.
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

const PARTY_TABLES = {
  VENDOR: "SELECT name FROM suppliers WHERE id = ?",
  CUSTOMER: "SELECT name FROM customers WHERE id = ?",
  EMPLOYEE: "SELECT CONCAT(first_name, ' ', last_name) AS name FROM employees WHERE id = ?",
};

// Validates the Other Deposit and Cash Back lines off the request and returns them ready to
// insert, or { error }. Rows the form left completely blank are dropped rather than refused, the
// way the form's own empty starter row would otherwise block every save. The party's name is read
// from its record rather than taken from the browser, so the two cannot disagree.
async function normaliseLines(conn, otherDeposits, cashBacks) {
  const out = [];
  const kinds = [['other', 'Other Deposit', otherDeposits], ['cashback', 'Cash Back', cashBacks]];
  for (const [lineType, label, raw] of kinds) {
    let lineNo = 0;
    for (const l of Array.isArray(raw) ? raw : []) {
      const amount = round2(l.amount);
      const blank = !amount && !l.account_id && !l.party_id && !l.payment_method_id && !l.department_id && !l.location_id && !String(l.memo || '').trim();
      if (blank) continue;
      lineNo += 1;
      if (amount <= 0) return { error: `${label} line ${lineNo}: enter an amount above zero.` };
      if (!l.account_id) return { error: `${label} line ${lineNo}: select an account.` };
      const [[acct]] = await conn.query('SELECT id FROM chart_of_accounts WHERE id = ?', [l.account_id]);
      if (!acct) return { error: `${label} line ${lineNo}: that account no longer exists.` };

      let partyType = null; let partyId = null; let partyName = null;
      if (lineType === 'other' && l.party_type && l.party_id) {
        partyType = String(l.party_type).toUpperCase();
        if (!PARTY_TABLES[partyType]) return { error: `${label} line ${lineNo}: unknown name type.` };
        const [[p]] = await conn.query(PARTY_TABLES[partyType], [l.party_id]);
        if (!p) return { error: `${label} line ${lineNo}: that name no longer exists.` };
        partyId = Number(l.party_id); partyName = trunc(p.name, 255);
      }
      out.push({
        line_type: lineType, line_no: lineNo, party_type: partyType, party_id: partyId, party_name: partyName,
        amount, account_id: Number(l.account_id),
        payment_method_id: lineType === 'other' ? (Number(l.payment_method_id) || null) : null,
        department_id: Number(l.department_id) || null, location_id: Number(l.location_id) || null,
        memo: trunc(l.memo, 1000),
      });
    }
  }
  return out;
}

// Lookups for the create form: bank accounts (COA detail_type 'Bank') + not-yet-deposited payments,
// and for the Other Deposit / Cash Back lines: posting accounts, payment methods, departments,
// locations and the three party sources for the Name picker (the same ones Journals offer).
router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [accounts] = await pool.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE detail_type = 'Bank' ORDER BY account_code");
    // Non-summary, not is_active: the flag is unreliable in the migrated chart (see routes/journals.js).
    const [lineAccounts] = await pool.query(
      'SELECT id, account_code, account_name, account_type FROM chart_of_accounts WHERE (is_summary = 0 OR is_summary IS NULL) ORDER BY account_code'
    );
    const [paymentMethods] = await pool.query('SELECT id, name FROM payment_methods WHERE is_active = TRUE ORDER BY name');
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    const [locations] = await pool.query('SELECT id, location_name FROM locations ORDER BY location_name');
    const [vendors] = await pool.query('SELECT id, name FROM suppliers WHERE is_active = TRUE ORDER BY name');
    const [customers] = await pool.query('SELECT id, name FROM customers ORDER BY name');
    const [employees] = await pool.query("SELECT id, CONCAT(first_name, ' ', last_name) AS name FROM employees WHERE is_active = TRUE ORDER BY first_name, last_name");
    const [payments] = await pool.query(
      `SELECT cp.id, cp.customer_payment_no, cp.date_created, cp.payment_amount,
              c.name AS customer_name, loc.location_name, pm.name AS payment_method_name
       FROM customer_payments cp
       LEFT JOIN customers c ON c.id = cp.customer_id
       LEFT JOIN locations loc ON loc.id = cp.office_location_id
       LEFT JOIN payment_methods pm ON pm.id = cp.payment_method_id
       WHERE cp.status = 'not_deposited' AND cp.deposit_id IS NULL ORDER BY cp.id DESC LIMIT 1000`
    );
    res.json({ accounts, payments, lineAccounts, paymentMethods, departments, locations, vendors, customers, employees });
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
    // Guarded so a deploy that lands before src/db/add-deposit-other-lines.js has run still opens
    // every deposit rather than 500ing on the missing table.
    const [lineTbl] = await pool.query("SHOW TABLES LIKE 'bank_deposit_lines'");
    const [lines] = !lineTbl.length ? [[]] : await pool.query(
      `SELECT l.*, coa.account_code, coa.account_name, pm.name AS payment_method_name,
              dep.name AS department_name, loc.location_name
       FROM bank_deposit_lines l
       JOIN chart_of_accounts coa ON coa.id = l.account_id
       LEFT JOIN payment_methods pm ON pm.id = l.payment_method_id
       LEFT JOIN departments dep ON dep.id = l.department_id
       LEFT JOIN locations loc ON loc.id = l.location_id
       WHERE l.deposit_id = ? ORDER BY l.line_type, l.line_no`,
      [req.params.id]
    );
    const [[uf]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '10006'");
    res.json({ ...d, payments, lines, gl: depositGlRows(d, lines, uf) });
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

    const lines = await normaliseLines(conn, req.body.other_deposits, req.body.cash_backs);
    if (lines.error) return res.status(400).json({ error: lines.error });
    // A deposit of nothing but Other Deposit lines is still money going to the bank; a deposit of
    // nothing but Cash Back is not, which the net-total check below catches.
    if (!ids.length && !lines.some((l) => l.line_type === 'other')) {
      return res.status(400).json({ error: 'Select at least one payment or add an Other Deposit.' });
    }

    let pays = [];
    if (ids.length) {
      [pays] = await conn.query(
        "SELECT id, payment_amount, status, deposit_id FROM customer_payments WHERE id IN (?)", [ids]
      );
    }
    if (pays.length !== ids.length) return res.status(400).json({ error: 'One or more payments are no longer valid.' });
    for (const p of pays) {
      if (p.deposit_id || p.status === 'deposited') return res.status(409).json({ error: 'One or more payments are already deposited.' });
      if (p.status === 'voided') return res.status(409).json({ error: 'A voided payment cannot be deposited.' });
    }
    const paymentsTotal = pays.reduce((s, p) => s + num(p.payment_amount), 0);
    const otherTotal = lines.filter((l) => l.line_type === 'other').reduce((s, l) => s + l.amount, 0);
    const cashBackTotal = lines.filter((l) => l.line_type === 'cashback').reduce((s, l) => s + l.amount, 0);
    const total = round2(paymentsTotal + otherTotal - cashBackTotal);
    if (total <= 0) {
      return res.status(400).json({ error: 'Cash Back cannot be as much as the payments and Other Deposits together -- the deposit total must be above zero.' });
    }
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
    if (ids.length) {
      await conn.query("UPDATE customer_payments SET deposit_id = ?, status = 'deposited' WHERE id IN (?)", [depositId, ids]);
    }
    for (const l of lines) {
      await conn.query(
        `INSERT INTO bank_deposit_lines (deposit_id, line_type, line_no, party_type, party_id, party_name, amount,
                                         account_id, payment_method_id, department_id, location_id, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [depositId, l.line_type, l.line_no, l.party_type, l.party_id, l.party_name, l.amount,
          l.account_id, l.payment_method_id, l.department_id, l.location_id, l.memo]
      );
    }
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
