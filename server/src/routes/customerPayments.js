const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeCustomerPaymentGl } = require('../lib/glImpact');

const router = express.Router();
// Reached from an Open Invoice's "Accept Payment" button -- the AR mirror of Bill
// Payment. One payment can settle several of the same customer's open invoices at once
// (the APPLY tab) and/or draw on that customer's existing open Credit Memos (the CREDITS
// tab).
const ROUTE = '/customer-payments';

async function logAudit(conn, { paymentId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('CustomerPayment', ?, ?, ?, ?, ?, ?)`,
    [paymentId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Draws an invoice's Amount Due down and flips it to paid_in_full when it lands at zero.
// Rejects rather than clamps an over-application, the same discipline used for every
// other amount cap in this codebase.
async function applyToInvoice(conn, invoiceId, amount) {
  const [[si]] = await conn.query('SELECT invoice_no, amount_due, status FROM sales_invoices WHERE id = ?', [invoiceId]);
  if (!si) throw Object.assign(new Error('One of the selected invoices is no longer valid.'), { status: 400 });
  if (si.status === 'cancelled') throw Object.assign(new Error(`${si.invoice_no} is void and cannot be paid.`), { status: 409 });
  if (amount > Number(si.amount_due) + 1e-9) {
    throw Object.assign(new Error(`Applied Amount (${amount}) exceeds ${si.invoice_no}'s remaining Amount Due (${si.amount_due}).`), { status: 409 });
  }
  const newDue = Number((Number(si.amount_due) - amount).toFixed(2));
  await conn.query(
    "UPDATE sales_invoices SET amount_due = ?, status = IF(? <= 0.005, 'paid_in_full', status) WHERE id = ?",
    [newDue, newDue, invoiceId]
  );
}

async function reverseInvoiceApplication(conn, invoiceId, amount) {
  const [[si]] = await conn.query('SELECT amount_due, status FROM sales_invoices WHERE id = ?', [invoiceId]);
  if (!si) return;
  const newDue = Number((Number(si.amount_due) + amount).toFixed(2));
  await conn.query(
    "UPDATE sales_invoices SET amount_due = ?, status = IF(status = 'paid_in_full' AND ? > 0.005, 'saved', status) WHERE id = ?",
    [newDue, newDue, invoiceId]
  );
}

// Powers the Customer Payment modal. Every one of this customer's still-open invoices is
// offered in the APPLY tab -- not just the one the button was pressed from -- because a
// single payment routinely settles several at once; the source invoice is flagged so the
// form can tick it by default.
router.get('/for-invoice/:invoiceId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[si]] = await pool.query(
      `SELECT si.id AS sales_invoice_id, si.invoice_no, si.office_location_id, si.department_id, si.memo,
              si.amount_due, so.customer_id, c.name AS customer_name,
              loc.location_name AS office_location_name, d.name AS department_name
       FROM sales_invoices si
       JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN locations loc ON loc.id = si.office_location_id
       LEFT JOIN departments d ON d.id = si.department_id
       WHERE si.id = ?`,
      [req.params.invoiceId]
    );
    if (!si) return res.status(404).json({ error: 'Not found' });

    const [applyLines] = await pool.query(
      `SELECT si2.id AS sales_invoice_id, si2.invoice_no, si2.date_created, si2.gross_amount, si2.amount_due,
              c.name AS customer_name
       FROM sales_invoices si2
       JOIN sales_orders so2 ON so2.id = si2.sales_order_id
       LEFT JOIN customers c ON c.id = so2.customer_id
       WHERE so2.customer_id = ? AND si2.status != 'cancelled' AND si2.amount_due > 0
       ORDER BY si2.id DESC`,
      [si.customer_id]
    );

    const [creditLines] = await pool.query(
      `SELECT id AS credit_memo_id, credit_memo_no, date_created, gross_amount, applied_amount,
              (gross_amount - applied_amount) AS remaining
       FROM credit_memos
       WHERE customer_id = ? AND status = 'open' AND applied_amount < gross_amount
       ORDER BY id DESC`,
      [si.customer_id]
    );

    res.json({ ...si, apply_lines: applyLines, credit_lines: creditLines });
  } catch (err) {
    next(err);
  }
});

router.get('/by-invoice/:invoiceId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT cp.id, cp.customer_payment_no, cp.date_created, cpl.applied_amount, cp.status
       FROM customer_payments cp
       JOIN customer_payment_lines cpl ON cpl.customer_payment_id = cp.id
       WHERE cpl.sales_invoice_id = ? ORDER BY cp.id DESC`,
      [req.params.invoiceId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('cp.status = ?'); params.push(status); }
    if (search) {
      where.push('(cp.customer_payment_no LIKE ? OR cp.or_no LIKE ? OR c.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT cp.id, cp.customer_payment_no, cp.date_created, cp.or_no, cp.payment_amount, cp.applied_amount,
              cp.unapplied_amount, cp.status, c.name AS customer_name, pm.name AS payment_method_name
       FROM customer_payments cp
       LEFT JOIN customers c ON c.id = cp.customer_id
       LEFT JOIN payment_methods pm ON pm.id = cp.payment_method_id
       ${whereSql}
       ORDER BY cp.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[cp]] = await pool.query(
      `SELECT cp.*, c.name AS customer_name, d.name AS department_name,
              loc.location_name AS office_location_name, pm.name AS payment_method_name,
              dep.account_code AS deposit_account_code, dep.account_name AS deposit_account_name,
              iu.display_name AS issued_by_name, u.display_name AS created_by_name
       FROM customer_payments cp
       LEFT JOIN customers c ON c.id = cp.customer_id
       LEFT JOIN departments d ON d.id = cp.department_id
       LEFT JOIN locations loc ON loc.id = cp.office_location_id
       LEFT JOIN payment_methods pm ON pm.id = cp.payment_method_id
       LEFT JOIN chart_of_accounts dep ON dep.id = cp.deposit_account_id
       LEFT JOIN users iu ON iu.id = cp.issued_by_user_id
       LEFT JOIN users u ON u.id = cp.created_by_user_id
       WHERE cp.id = ?`,
      [req.params.id]
    );
    if (!cp) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT cpl.*, si.invoice_no, si.date_created AS invoice_date, si.gross_amount AS invoice_gross,
              cm.credit_memo_no
       FROM customer_payment_lines cpl
       LEFT JOIN sales_invoices si ON si.id = cpl.sales_invoice_id
       LEFT JOIN credit_memos cm ON cm.id = cpl.credit_memo_id
       WHERE cpl.customer_payment_id = ?`,
      [req.params.id]
    );

    const glImpact = await computeCustomerPaymentGl(cp, lines);
    res.json({ ...cp, lines, gl_impact: glImpact });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'CustomerPayment' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      customer_id: customerId, date_created: dateCreated, department_id: departmentId,
      office_location_id: officeLocationId, ar_account_id: arAccountId, deposit_account_id: depositAccountId,
      receipt_type: receiptType, or_no: orNo, payment_type: paymentType, issued_by_user_id: issuedByUserId,
      payment_method_id: paymentMethodId, payment_amount: paymentAmount, memo,
      apply_lines: applyLines, credit_lines: creditLines,
    } = req.body;

    if (!customerId) return res.status(400).json({ error: 'Customer is required.' });

    const submittedApply = (Array.isArray(applyLines) ? applyLines : []).filter((l) => l.sales_invoice_id && Number(l.applied_amount) > 0);
    const submittedCredits = (Array.isArray(creditLines) ? creditLines : []).filter((l) => l.credit_memo_id && Number(l.applied_amount) > 0);
    if (!submittedApply.length && !submittedCredits.length) {
      return res.status(400).json({ error: 'Apply at least one amount to an invoice or credit.' });
    }

    // Re-check every credit against its fresh remaining balance before writing anything.
    for (const l of submittedCredits) {
      const [[cm]] = await conn.query('SELECT gross_amount, applied_amount, status FROM credit_memos WHERE id = ?', [l.credit_memo_id]);
      if (!cm || cm.status !== 'open') return res.status(400).json({ error: 'One of the selected credits is no longer valid.' });
      const remaining = Number(cm.gross_amount) - Number(cm.applied_amount);
      if (Number(l.applied_amount) > remaining + 1e-9) {
        return res.status(409).json({ error: `Applied Amount (${l.applied_amount}) exceeds this credit's remaining balance (${remaining}).` });
      }
    }

    const appliedTotal = Number(
      [...submittedApply, ...submittedCredits].reduce((s, l) => s + Number(l.applied_amount), 0).toFixed(2)
    );
    // The cash actually received. Defaults to what was applied when the form doesn't say
    // otherwise; anything beyond that is unapplied cash sitting on account.
    const received = paymentAmount === undefined || paymentAmount === null || paymentAmount === ''
      ? appliedTotal
      : Number(paymentAmount);
    const creditsTotal = Number(submittedCredits.reduce((s, l) => s + Number(l.applied_amount), 0).toFixed(2));
    // Credits offset the bill without cash changing hands, so they don't count against
    // what was received -- only the invoice-applied portion consumes the payment.
    const cashApplied = Number((appliedTotal - creditsTotal).toFixed(2));
    if (cashApplied > received + 1e-9) {
      return res.status(409).json({
        error: `Applied Amount (${cashApplied}) exceeds the Payment Amount (${received}). Raise the payment or lower what you're applying.`,
      });
    }
    const unapplied = Number((received - cashApplied).toFixed(2));

    await conn.beginTransaction();

    for (const l of submittedApply) {
      await applyToInvoice(conn, l.sales_invoice_id, Number(l.applied_amount));
    }
    for (const l of submittedCredits) {
      await conn.query('UPDATE credit_memos SET applied_amount = applied_amount + ? WHERE id = ?', [Number(l.applied_amount), l.credit_memo_id]);
    }

    const [result] = await conn.query(
      `INSERT INTO customer_payments
         (customer_payment_no, date_created, customer_id, department_id, office_location_id, ar_account_id,
          deposit_account_id, receipt_type, or_no, payment_type, issued_by_user_id, payment_method_id,
          payment_amount, applied_amount, unapplied_amount, memo, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dateCreated || new Date().toISOString().slice(0, 10), customerId, departmentId || null,
        officeLocationId || null, arAccountId || null, depositAccountId || null, receiptType || null,
        orNo || null, paymentType || null, issuedByUserId || req.user.id, paymentMethodId || null,
        received, appliedTotal, unapplied, memo || null, req.user.id,
      ]
    );
    const paymentId = result.insertId;
    await conn.query('UPDATE customer_payments SET customer_payment_no = ? WHERE id = ?', [`CPAY-${paymentId}`, paymentId]);

    for (const l of submittedApply) {
      await conn.query(
        'INSERT INTO customer_payment_lines (customer_payment_id, sales_invoice_id, applied_amount) VALUES (?, ?, ?)',
        [paymentId, l.sales_invoice_id, l.applied_amount]
      );
    }
    for (const l of submittedCredits) {
      await conn.query(
        'INSERT INTO customer_payment_lines (customer_payment_id, credit_memo_id, applied_amount) VALUES (?, ?, ?)',
        [paymentId, l.credit_memo_id, l.applied_amount]
      );
    }

    await logAudit(conn, { paymentId, userId: req.user.id, eventType: 'Created', fieldName: 'customer_payment_no', newValue: `CPAY-${paymentId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM customer_payments WHERE id = ?', [paymentId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[cp]] = await conn.query('SELECT status FROM customer_payments WHERE id = ?', [req.params.id]);
    if (!cp) return res.status(404).json({ error: 'Not found' });
    if (cp.status === 'voided') return res.status(409).json({ error: 'This Customer Payment is already voided.' });
    const priorStatus = cp.status;

    const [lines] = await conn.query(
      'SELECT sales_invoice_id, credit_memo_id, applied_amount FROM customer_payment_lines WHERE customer_payment_id = ?',
      [req.params.id]
    );

    await conn.beginTransaction();
    for (const l of lines) {
      if (l.sales_invoice_id) await reverseInvoiceApplication(conn, l.sales_invoice_id, Number(l.applied_amount));
      if (l.credit_memo_id) {
        await conn.query('UPDATE credit_memos SET applied_amount = GREATEST(applied_amount - ?, 0) WHERE id = ?', [Number(l.applied_amount), l.credit_memo_id]);
      }
    }
    await conn.query("UPDATE customer_payments SET status = 'voided', voided_by_user_id = ?, voided_at = NOW() WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { paymentId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: priorStatus, newValue: 'voided' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM customer_payments WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
