const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeCustomerPaymentGl } = require('../lib/glImpact');
const { assertPeriodOpen } = require('../lib/accountingPeriod');

const router = express.Router();
// Reached from an Open Invoice's "Accept Payment" button -- the AR mirror of Bill
// Payment. One payment can settle several of the same customer's open invoices at once
// (the APPLY tab) and/or draw on that customer's existing open Credit Memos (the CREDITS
// tab).
const ROUTE = '/customer-payments';

// The page asks for ten. The cap exists so a hand-written page_size cannot ask for all 130,000
// back and undo the reason this endpoint is paged at all.
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 200;

// A date filter that is not a date is a typo or a stale bookmark, not a reason to fail the
// request: MySQL rejects 'notadate' in a DATE comparison and the whole list 500s. Anything that
// is not YYYY-MM-DD is dropped, so the page comes back unfiltered rather than broken.
const asDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

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

// Validates what is being applied and works out the three figures that must agree: what was
// applied, what cash was received, and what is left sitting on account. Shared by create and
// edit -- these are money, and two copies of the arithmetic would eventually disagree.
//
// An edit calls this AFTER reversing its own previous application, so every balance checked here
// is the balance as it would be if this payment had never existed. That ordering is what lets an
// unchanged payment be re-saved: check first and the invoice it settles no longer has the
// balance it is settling, so its own application reads as an over-application.
async function prepareApplication(conn, { applyLines, creditLines, paymentAmount }) {
  const submittedApply = (Array.isArray(applyLines) ? applyLines : [])
    .filter((l) => l.sales_invoice_id && Number(l.applied_amount) > 0);
  const submittedCredits = (Array.isArray(creditLines) ? creditLines : [])
    .filter((l) => l.credit_memo_id && Number(l.applied_amount) > 0);

  // Nothing applied is allowed: the whole payment then sits unapplied, on account (an advance, or
  // cash for invoices not raised yet), and posts to 23000 Customer Deposits -- see
  // computeCustomerPaymentGl. What it cannot be is nothing at all.
  if (!submittedApply.length && !submittedCredits.length && !(Number(paymentAmount) > 0)) {
    throw Object.assign(new Error('Enter a Payment Amount, or apply an amount to an invoice or credit.'), { status: 400 });
  }

  for (const l of submittedCredits) {
    const [[cm]] = await conn.query('SELECT gross_amount, applied_amount, status FROM credit_memos WHERE id = ?', [l.credit_memo_id]);
    if (!cm || cm.status !== 'open') {
      throw Object.assign(new Error('One of the selected credits is no longer valid.'), { status: 400 });
    }
    const remaining = Number(cm.gross_amount) - Number(cm.applied_amount);
    if (Number(l.applied_amount) > remaining + 1e-9) {
      throw Object.assign(
        new Error(`Applied Amount (${l.applied_amount}) exceeds this credit's remaining balance (${remaining}).`),
        { status: 409 },
      );
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
  // Credits offset the bill without cash changing hands, so they don't count against what was
  // received -- only the invoice-applied portion consumes the payment.
  const cashApplied = Number((appliedTotal - creditsTotal).toFixed(2));
  if (cashApplied > received + 1e-9) {
    throw Object.assign(new Error(
      `Applied Amount (${cashApplied}) exceeds the Payment Amount (${received}). Raise the payment or lower what you're applying.`,
    ), { status: 409 });
  }
  return {
    submittedApply,
    submittedCredits,
    appliedTotal,
    received,
    unapplied: Number((received - cashApplied).toFixed(2)),
  };
}

// Every field on the Customer Payment form is required except Deposit To, which may be left for
// the Bank Deposit (an undeposited receipt sits in 10006 Undeposited Funds meanwhile -- see
// computeCustomerPaymentGl). The method decides the rest: a cheque needs its bank, date and
// number, a method flagged requires_reference needs its reference. Checked here as well as on the
// form, since the form is one way in and this is the only one. Returns the first thing missing,
// or null.
//
// Payment Amount may be zero only when the payment is nothing but credit memos offsetting
// invoices -- that moves no cash, so there is no amount to have received.
const isChequeMethod = (name) => /^che(ck|que)$/.test(String(name || '').trim().toLowerCase());
async function missingRequired(conn, b) {
  const blank = (v) => v == null || String(v).trim() === '';
  if (blank(b.date_created)) return 'Date';
  if (!b.department_id) return 'Department';
  if (blank(b.memo)) return 'Memo';
  if (blank(b.receipt_type)) return 'Receipt';
  if (blank(b.or_no)) return 'OR #';
  if (blank(b.payment_type)) return 'Payment Type';
  if (!b.issued_by_user_id) return 'Issued By';
  const creditsOnly = (Array.isArray(b.credit_lines) && b.credit_lines.some((l) => Number(l.applied_amount) > 0))
    && !(Array.isArray(b.apply_lines) && b.apply_lines.some((l) => Number(l.applied_amount) > 0));
  if (!(Number(b.payment_amount) > 0) && !creditsOnly) return 'Payment Amount';
  if (!b.payment_method_id) return 'Payment Method';
  const [[m]] = await conn.query('SELECT name, requires_reference FROM payment_methods WHERE id = ?', [b.payment_method_id]);
  if (!m) return 'Payment Method';
  if (isChequeMethod(m.name)) {
    if (blank(b.bank_name)) return 'Bank';
    if (blank(b.cheque_date)) return 'Cheque Date';
    if (blank(b.cheque_no)) return 'Cheque No';
  } else if (m.requires_reference && blank(b.reference_no)) {
    return 'Reference No';
  }
  return null;
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
      // An invoice raised from an Estimate has no Sales Order, so the customer comes from
      // whichever source it has. An INNER JOIN here made the payment form fail to load at all
      // for those invoices -- they could be raised but never collected.
      `SELECT si.id AS sales_invoice_id, si.invoice_no, si.office_location_id, si.department_id, si.memo,
              si.amount_due, COALESCE(so.customer_id, e.customer_id) AS customer_id, c.name AS customer_name,
              loc.location_name AS office_location_name, d.name AS department_name
       FROM sales_invoices si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, e.customer_id)
       LEFT JOIN locations loc ON loc.id = si.office_location_id
       LEFT JOIN departments d ON d.id = si.department_id
       WHERE si.id = ?`,
      [req.params.invoiceId]
    );
    if (!si) return res.status(404).json({ error: 'Not found' });

    const [applyLines] = await pool.query(
      // Same reason: an estimate-sourced invoice belongs in this customer's open items too,
      // otherwise a payment settling several invoices at once would silently skip it.
      `SELECT si2.id AS sales_invoice_id, si2.invoice_no, si2.date_created, si2.gross_amount, si2.amount_due,
              c.name AS customer_name
       FROM sales_invoices si2
       LEFT JOIN sales_orders so2 ON so2.id = si2.sales_order_id
       LEFT JOIN estimates e2 ON e2.id = si2.estimate_id
       LEFT JOIN customers c ON c.id = COALESCE(so2.customer_id, e2.customer_id)
       WHERE COALESCE(so2.customer_id, e2.customer_id) = ? AND si2.status != 'cancelled' AND si2.amount_due > 0
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

// The same payload as /for-invoice, for a payment raised from the Customer Payments list rather
// than from one invoice's Accept Payment button. Nothing is pre-selected because nothing singled
// an invoice out -- the customer handed over money and the person entering it decides what it
// settles.
//
// Deliberately the SAME SHAPE, so one modal serves both ways in: apply_lines are all this
// customer's still-open invoices, credit_lines their open credit memos. sales_invoice_id and
// amount_due are the two fields that only make sense when an invoice started it, and they are
// absent here rather than faked.
//
// Declared above `/:id` -- Express matches in the order routes are registered, so a literal
// segment has to come first or `/:id` swallows it.
// Who can be named as having issued the receipt, for the "Issued By" picker on the payment form.
//
// The form used to read the full /users list for this, which is gated on the USERS ADMIN PAGE.
// That is the wrong gate: it meant anyone allowed to take a customer's money also had to be
// allowed to administer user accounts, and Accounting quite reasonably is not. The whole form
// died on that one 403 -- the fetches run in a Promise.all, so a single refusal takes the lot.
//
// Gated by the page it serves, like every other endpoint here, and it returns NAMES ONLY: the
// same display names already printed on every document in the system, not the account records
// /users hands to the admin screens.
router.get('/meta/issuers', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, display_name FROM users WHERE is_active = 1 ORDER BY display_name');
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/for-customer/:customerId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[customer]] = await pool.query(
      'SELECT id AS customer_id, name AS customer_name FROM customers WHERE id = ?', [req.params.customerId]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const [applyLines] = await pool.query(
      // Reached from Customer Payments' own New button rather than from an invoice, and it has
      // to show the same open items the invoice-sourced form does -- estimate-sourced included.
      // `payment_id` puts this into EDIT mode. An invoice a payment already settled in full has
      // no Amount Due left, so the plain "open items" list would not offer it and the edit form
      // could not show -- let alone reduce -- what the payment is currently applying to it. The
      // invoices this payment settled are therefore included regardless of their balance, and
      // each row carries what this payment already draws from it, so the form can work out how
      // much is really available: amount_due plus its own existing application.
      `SELECT si.id AS sales_invoice_id, si.invoice_no, si.date_created, si.gross_amount, si.amount_due,
              c.name AS customer_name,
              COALESCE(mine.applied_amount, 0) AS applied_by_this_payment
         FROM sales_invoices si
         LEFT JOIN sales_orders so ON so.id = si.sales_order_id
         LEFT JOIN estimates e ON e.id = si.estimate_id
         LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, e.customer_id)
         LEFT JOIN customer_payment_lines mine
                ON mine.sales_invoice_id = si.id AND mine.customer_payment_id = ?
        WHERE COALESCE(so.customer_id, e.customer_id) = ? AND si.status != 'cancelled'
          AND (si.amount_due > 0 OR mine.id IS NOT NULL)
        ORDER BY si.id DESC`,
      [req.query.payment_id || 0, req.params.customerId],
    );

    const [creditLines] = await pool.query(
      // Same reasoning as the invoices above: a credit this payment has already drawn to zero
      // still has to be offered, or an edit could not reduce its own draw on it.
      `SELECT cm.id AS credit_memo_id, cm.credit_memo_no, cm.date_created, cm.gross_amount, cm.applied_amount,
              (cm.gross_amount - cm.applied_amount) AS remaining,
              COALESCE(mine.applied_amount, 0) AS applied_by_this_payment
         FROM credit_memos cm
         LEFT JOIN customer_payment_lines mine
                ON mine.credit_memo_id = cm.id AND mine.customer_payment_id = ?
        WHERE cm.customer_id = ? AND cm.status = 'open'
          AND (cm.applied_amount < cm.gross_amount OR mine.id IS NOT NULL)
        ORDER BY cm.id DESC`,
      [req.query.payment_id || 0, req.params.customerId],
    );

    res.json({
      ...customer,
      office_location_id: null,
      department_id: null,
      memo: null,
      apply_lines: applyLines,
      credit_lines: creditLines,
    });
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

// PAGED AT THE DATABASE, not in the browser. This list used to select every row and let the page
// slice ten out of it: 130,000 payments, 34.5 MB of JSON, several seconds of spinner, to draw a
// table ten rows tall. The count grows with every receipt the company writes, so the page got
// slower every day it was used.
//
// The response shape is { rows, total, page, page_size } -- the same shape the other paged lists
// in this codebase return -- because the footer still has to say how many pages there are, and
// that number no longer comes from rows.length.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status, department_id: departmentId, office_location_id: locationId } = req.query;
    const dateFrom = asDate(req.query.date_from);
    const dateTo = asDate(req.query.date_to);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.page_size) || DEFAULT_PAGE_SIZE));

    const where = [];
    const params = [];
    if (status) { where.push('cp.status = ?'); params.push(status); }
    if (departmentId) { where.push('cp.department_id = ?'); params.push(departmentId); }
    // Location, not just department. Every one of the 130,000 imported payments carries an office
    // location and all but two carry no department at all, so department alone would be a filter
    // that returns nothing for the entire history. Payments raised through the form do set a
    // department, so that filter earns its place going forward -- this one works on both.
    if (locationId) { where.push('cp.office_location_id = ?'); params.push(locationId); }
    // Both ends inclusive, and each usable without the other -- "everything from March" and
    // "everything up to year end" are both things people ask for. date_created is a DATE, so
    // there is no end-of-day boundary to get wrong here.
    if (dateFrom) { where.push('cp.date_created >= ?'); params.push(dateFrom); }
    if (dateTo) { where.push('cp.date_created <= ?'); params.push(dateTo); }
    if (search) {
      where.push('(cp.customer_payment_no LIKE ? OR cp.or_no LIKE ? OR c.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // The COUNT only joins customers when the search needs it. That join is the whole cost of
    // counting: matching 130,000 payments to 21,000 customers took 734ms on a warm clone, and
    // every unfiltered page load paid it for a number that does not depend on the join at all.
    // With the join dropped the count is read straight off the payments table.
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM customer_payments cp
       ${search ? 'LEFT JOIN customers c ON c.id = cp.customer_id' : ''}
       ${whereSql}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT cp.id, cp.customer_payment_no, cp.date_created, cp.or_no, cp.payment_amount, cp.applied_amount,
              cp.unapplied_amount, cp.status, c.name AS customer_name, pm.name AS payment_method_name,
              d.name AS department_name, loc.location_name AS office_location_name
       FROM customer_payments cp
       LEFT JOIN customers c ON c.id = cp.customer_id
       LEFT JOIN payment_methods pm ON pm.id = cp.payment_method_id
       LEFT JOIN departments d ON d.id = cp.department_id
       LEFT JOIN locations loc ON loc.id = cp.office_location_id
       ${whereSql}
       ORDER BY cp.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    res.json({ rows, total, page, page_size: pageSize });
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
      // How the money actually arrived. Which of these the form collects depends on the method:
      // a reference for GCASH/Maya/Card/Online Deposit, the cheque trio for CHECK, neither for
      // cash. Stored as sent -- the form decides what to ask for off the payment_methods master
      // list, and re-deciding it here would mean two places to keep in step with that list.
      reference_no: referenceNo, bank_name: bankName, cheque_no: chequeNo, cheque_date: chequeDate,
      apply_lines: applyLines, credit_lines: creditLines,
    } = req.body;

    if (!customerId) return res.status(400).json({ error: 'Customer is required.' });
    const missing = await missingRequired(conn, req.body);
    if (missing) return res.status(400).json({ error: `${missing} is required.` });

    await assertPeriodOpen(dateCreated, 'ar', conn);

    // Shared with the edit path so the two can never disagree about what was applied, what was
    // received, and what is left on account.
    const { submittedApply, submittedCredits, appliedTotal, received, unapplied } =
      await prepareApplication(conn, { applyLines, creditLines, paymentAmount });

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
          payment_amount, applied_amount, unapplied_amount, memo, created_by_user_id,
          reference_no, bank_name, cheque_no, cheque_date)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dateCreated || new Date().toISOString().slice(0, 10), customerId, departmentId || null,
        officeLocationId || null, arAccountId || null, depositAccountId || null, receiptType || null,
        orNo || null, paymentType || null, issuedByUserId || req.user.id, paymentMethodId || null,
        received, appliedTotal, unapplied, memo || null, req.user.id,
        referenceNo || null, bankName || null, chequeNo || null, chequeDate || null,
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
    const [[cp]] = await conn.query('SELECT status, date_created FROM customer_payments WHERE id = ?', [req.params.id]);
    if (cp) await assertPeriodOpen(cp.date_created, 'ar', conn);
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

// Editing a payment that has not been deposited yet.
//
// WHY ONLY UNTIL IT IS DEPOSITED. A deposit sweeps the receipt into the bank and becomes the
// thing a bank statement is reconciled against; changing the amount underneath it would put the
// deposit and the bank out of step with nothing recording that it happened. Up to that point the
// receipt is still just a record of cash in the drawer, and correcting a mistyped amount or a
// wrong invoice is ordinary work -- which previously meant voiding and re-keying the whole thing,
// leaving a void in the ledger for what was really a typo.
//
// Applying a payment moves money on the invoices it settles, so an edit has to UNDO the old
// application before laying down the new one. Both happen in one transaction: a failure halfway
// would otherwise leave invoices credited for a payment that no longer claims them.
//
// No GL to unwind -- computeCustomerPaymentGl derives the entries on read rather than storing
// them, so the new figures are reflected the moment they are saved.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[cp]] = await conn.query(
      'SELECT id, status, date_created FROM customer_payments WHERE id = ?', [req.params.id],
    );
    if (!cp) return res.status(404).json({ error: 'Not found' });
    if (cp.status === 'voided') {
      return res.status(409).json({ error: 'A voided Customer Payment cannot be edited.' });
    }
    if (cp.status !== 'not_deposited') {
      return res.status(409).json({
        error: 'This payment has been deposited and can no longer be edited. Void it and re-enter if it is wrong.',
      });
    }

    const {
      date_created: dateCreated, department_id: departmentId, office_location_id: officeLocationId,
      ar_account_id: arAccountId, deposit_account_id: depositAccountId, receipt_type: receiptType,
      or_no: orNo, payment_type: paymentType, issued_by_user_id: issuedByUserId,
      payment_method_id: paymentMethodId, payment_amount: paymentAmount, memo,
      reference_no: referenceNo, bank_name: bankName, cheque_no: chequeNo, cheque_date: chequeDate,
      apply_lines: applyLines, credit_lines: creditLines,
    } = req.body;
    const missing = await missingRequired(conn, req.body);
    if (missing) return res.status(400).json({ error: `${missing} is required.` });

    // Both periods: the one it sits in now and the one it is being moved to. Moving a receipt
    // out of a closed month is as much a change to that month as posting into one.
    await assertPeriodOpen(cp.date_created, 'ar', conn);
    if (dateCreated) await assertPeriodOpen(dateCreated, 'ar', conn);

    const [existing] = await conn.query(
      'SELECT sales_invoice_id, credit_memo_id, applied_amount FROM customer_payment_lines WHERE customer_payment_id = ?',
      [req.params.id],
    );
    await conn.beginTransaction();

    // Undo first, so the new application is checked against invoices and credits in the state
    // they would be in if this payment had never existed. Validating before the reversal would
    // reject re-saving an unchanged payment, because the invoice it settles no longer has the
    // balance it is settling.
    for (const l of existing) {
      if (l.sales_invoice_id) await reverseInvoiceApplication(conn, l.sales_invoice_id, Number(l.applied_amount));
      if (l.credit_memo_id) {
        await conn.query(
          'UPDATE credit_memos SET applied_amount = GREATEST(applied_amount - ?, 0) WHERE id = ?',
          [Number(l.applied_amount), l.credit_memo_id],
        );
      }
    }
    await conn.query('DELETE FROM customer_payment_lines WHERE customer_payment_id = ?', [req.params.id]);

    const { submittedApply, submittedCredits, appliedTotal, received, unapplied } =
      await prepareApplication(conn, { applyLines, creditLines, paymentAmount });

    for (const l of submittedApply) {
      await applyToInvoice(conn, l.sales_invoice_id, Number(l.applied_amount));
      await conn.query(
        'INSERT INTO customer_payment_lines (customer_payment_id, sales_invoice_id, applied_amount) VALUES (?, ?, ?)',
        [req.params.id, l.sales_invoice_id, l.applied_amount],
      );
    }
    for (const l of submittedCredits) {
      await conn.query('UPDATE credit_memos SET applied_amount = applied_amount + ? WHERE id = ?', [Number(l.applied_amount), l.credit_memo_id]);
      await conn.query(
        'INSERT INTO customer_payment_lines (customer_payment_id, credit_memo_id, applied_amount) VALUES (?, ?, ?)',
        [req.params.id, l.credit_memo_id, l.applied_amount],
      );
    }

    await conn.query(
      `UPDATE customer_payments SET
         date_created = ?, department_id = ?, office_location_id = ?, ar_account_id = ?,
         deposit_account_id = ?, receipt_type = ?, or_no = ?, payment_type = ?,
         issued_by_user_id = ?, payment_method_id = ?, payment_amount = ?, applied_amount = ?,
         unapplied_amount = ?, memo = ?, reference_no = ?, bank_name = ?, cheque_no = ?, cheque_date = ?
       WHERE id = ?`,
      [
        dateCreated || cp.date_created, departmentId || null, officeLocationId || null,
        arAccountId || null, depositAccountId || null, receiptType || null, orNo || null,
        paymentType || null, issuedByUserId || req.user.id, paymentMethodId || null,
        received, appliedTotal, unapplied, memo || null,
        referenceNo || null, bankName || null, chequeNo || null, chequeDate || null,
        req.params.id,
      ],
    );

    await logAudit(conn, { paymentId: req.params.id, userId: req.user.id, eventType: 'Updated' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM customer_payments WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
