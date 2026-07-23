const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeCreditMemoGl } = require('../lib/glImpact');

const router = express.Router();
// Reached from an Open Invoice's "Credit Memo" button -- the AR mirror of Bill Credit,
// but with sales-shaped lines rather than GL-account expense rows, because crediting a
// customer reverses goods or services sold and so has to reverse revenue and output VAT
// line by line.
const ROUTE = '/credit-memos';

async function logAudit(conn, { memoId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('CreditMemo', ?, ?, ?, ?, ?, ?)`,
    [memoId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Identical arithmetic to a Delivery Ticket line -- recomputed server-side from the four
// editable inputs rather than trusting the browser's preview.
function computeLineAmounts({ quantity, pricePerUnit, discPercent, taxRate }) {
  const qty = Number(quantity || 0);
  const price = Number(pricePerUnit || 0);
  const pct = Number(discPercent || 0);
  const subtotal = Number((price * qty).toFixed(2));
  const discAmount = Number((subtotal * (pct / 100)).toFixed(2));
  const discPerUnit = Number((price * (pct / 100)).toFixed(4));
  const discPricePerUnit = Number((price - discPerUnit).toFixed(4));
  const netOfTax = Number((subtotal - discAmount).toFixed(2));
  const taxAmount = Number((netOfTax * (Number(taxRate || 0) / 100)).toFixed(2));
  const grossAmount = Number((netOfTax + taxAmount).toFixed(2));
  return {
    subtotal, disc_amount: discAmount, disc_per_unit: discPerUnit, disc_price_per_unit: discPricePerUnit,
    net_of_tax: netOfTax, tax_amount: taxAmount, gross_amount: grossAmount,
  };
}

async function applyToInvoice(conn, invoiceId, amount) {
  const [[si]] = await conn.query('SELECT invoice_no, amount_due, status FROM sales_invoices WHERE id = ?', [invoiceId]);
  if (!si) throw Object.assign(new Error('One of the selected invoices is no longer valid.'), { status: 400 });
  if (si.status === 'cancelled') throw Object.assign(new Error(`${si.invoice_no} is void and cannot be credited.`), { status: 409 });
  if (amount > Number(si.amount_due) + 1e-9) {
    throw Object.assign(new Error(`Applied Amount (${amount}) exceeds ${si.invoice_no}'s remaining Amount Due (${si.amount_due}).`), { status: 409 });
  }
  const newDue = Number((Number(si.amount_due) - amount).toFixed(2));
  await conn.query(
    "UPDATE sales_invoices SET amount_due = ?, status = IF(? <= 0.005, 'paid_in_full', status) WHERE id = ?",
    [newDue, newDue, invoiceId]
  );
}

// Powers the Credit Memo modal. ITEMS starts empty (the real form's own behaviour -- you
// add exactly what's being credited back via Add Item), but the source invoice's lines
// come along as `invoice_lines` so the form can offer them as a starting point rather
// than making someone retype a line they're crediting in full.
router.get('/for-invoice/:invoiceId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[si]] = await pool.query(
      `SELECT si.id AS sales_invoice_id, si.invoice_no, si.office_location_id, si.memo, si.amount_due,
              si.gross_amount, si.status, so.customer_id, c.name AS customer_name,
              loc.location_name AS office_location_name
       FROM sales_invoices si
       JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN locations loc ON loc.id = si.office_location_id
       WHERE si.id = ?`,
      [req.params.invoiceId]
    );
    if (!si) return res.status(404).json({ error: 'Not found' });
    if (si.status === 'cancelled') return res.status(409).json({ error: 'This Invoice is void and cannot be credited.' });

    const [[arAcct]] = await pool.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code = '12100'");

    const [invoiceLines] = await pool.query(
      `SELECT sil.id AS sales_invoice_line_id, sil.job_order_id, jo.job_order_no, sil.description,
              sil.quantity, sil.units, sil.price_per_unit, sil.disc_percent, sil.tax_code,
              t.rate AS tax_rate
       FROM sales_invoice_lines sil
       LEFT JOIN job_orders jo ON jo.id = sil.job_order_id
       LEFT JOIN taxes t ON t.code = sil.tax_code
       WHERE sil.sales_invoice_id = ?`,
      [req.params.invoiceId]
    );

    const [applyLines] = await pool.query(
      `SELECT si2.id AS sales_invoice_id, si2.invoice_no, si2.date_created, si2.gross_amount, si2.amount_due
       FROM sales_invoices si2
       JOIN sales_orders so2 ON so2.id = si2.sales_order_id
       WHERE so2.customer_id = ? AND si2.status != 'cancelled' AND si2.amount_due > 0
       ORDER BY si2.id DESC`,
      [si.customer_id]
    );

    res.json({
      ...si,
      ar_account_id: arAcct?.id || null,
      ar_account_code: arAcct?.account_code || null,
      ar_account_name: arAcct?.account_name || null,
      invoice_lines: invoiceLines,
      apply_lines: applyLines,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/by-invoice/:invoiceId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, credit_memo_no, date_created, gross_amount, applied_amount, status
       FROM credit_memos WHERE sales_invoice_id = ? ORDER BY id DESC`,
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
    if (status) { where.push('cm.status = ?'); params.push(status); }
    if (search) {
      where.push('(cm.credit_memo_no LIKE ? OR c.name LIKE ? OR si.invoice_no LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT cm.id, cm.credit_memo_no, cm.date_created, cm.gross_amount, cm.applied_amount, cm.status,
              c.name AS customer_name, si.invoice_no
       FROM credit_memos cm
       LEFT JOIN customers c ON c.id = cm.customer_id
       LEFT JOIN sales_invoices si ON si.id = cm.sales_invoice_id
       ${whereSql}
       ORDER BY cm.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[cm]] = await pool.query(
      `SELECT cm.*, c.name AS customer_name, si.invoice_no, loc.location_name AS office_location_name,
              coa.account_code AS ar_account_code, coa.account_name AS ar_account_name,
              u.display_name AS created_by_name
       FROM credit_memos cm
       LEFT JOIN customers c ON c.id = cm.customer_id
       LEFT JOIN sales_invoices si ON si.id = cm.sales_invoice_id
       LEFT JOIN locations loc ON loc.id = cm.office_location_id
       LEFT JOIN chart_of_accounts coa ON coa.id = cm.ar_account_id
       LEFT JOIN users u ON u.id = cm.created_by_user_id
       WHERE cm.id = ?`,
      [req.params.id]
    );
    if (!cm) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT cml.*, jo.job_order_no, d.name AS department_name
       FROM credit_memo_lines cml
       LEFT JOIN job_orders jo ON jo.id = cml.job_order_id
       LEFT JOIN departments d ON d.id = cml.department_id
       WHERE cml.credit_memo_id = ? ORDER BY cml.line_no`,
      [req.params.id]
    );

    const [applications] = await pool.query(
      `SELECT cma.*, si.invoice_no, si.date_created AS invoice_date, si.gross_amount AS invoice_gross
       FROM credit_memo_applications cma
       LEFT JOIN sales_invoices si ON si.id = cma.sales_invoice_id
       WHERE cma.credit_memo_id = ?`,
      [req.params.id]
    );

    const glImpact = await computeCreditMemoGl(cm, lines);
    res.json({ ...cm, lines, applications, gl_impact: glImpact });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'CreditMemo' AND a.auditable_id = ?
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
      sales_invoice_id: salesInvoiceId, date_created: dateCreated, office_location_id: officeLocationId,
      ar_account_id: arAccountId, memo, lines, apply_lines: applyLines,
    } = req.body;
    if (!salesInvoiceId) return res.status(400).json({ error: 'Invoice is required.' });

    const [[si]] = await conn.query(
      `SELECT si.id, si.status, so.customer_id FROM sales_invoices si
       JOIN sales_orders so ON so.id = si.sales_order_id WHERE si.id = ?`,
      [salesInvoiceId]
    );
    if (!si) return res.status(404).json({ error: 'Invoice not found.' });
    if (si.status === 'cancelled') return res.status(409).json({ error: 'This Invoice is void and cannot be credited.' });

    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => Number(l.quantity) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Add at least one item to credit.' });

    const taxCodes = [...new Set(submitted.map((l) => l.tax_code).filter(Boolean))];
    const taxByCode = new Map();
    if (taxCodes.length) {
      const [rows] = await conn.query('SELECT code, rate FROM taxes WHERE code IN (?)', [taxCodes]);
      rows.forEach((r) => taxByCode.set(r.code, Number(r.rate)));
    }

    const prepared = submitted.map((l, idx) => {
      const quantity = Number(l.quantity);
      const pricePerUnit = Number(l.price_per_unit || 0);
      const discPercent = Number(l.disc_percent || 0);
      return {
        line_no: idx + 1,
        sales_invoice_line_id: l.sales_invoice_line_id || null,
        job_order_id: l.job_order_id || null,
        item_id: l.item_id || null,
        item_name: l.item_name || null,
        description: l.description || null,
        department_id: l.department_id || null,
        quantity,
        units: l.units || null,
        price_per_unit: pricePerUnit,
        disc_percent: discPercent,
        tax_code: l.tax_code || null,
        ...computeLineAmounts({ quantity, pricePerUnit, discPercent, taxRate: taxByCode.get(l.tax_code) || 0 }),
      };
    });

    const sum = (key) => Number(prepared.reduce((s, l) => s + Number(l[key] || 0), 0).toFixed(2));
    const subtotal = sum('subtotal');
    const discountAmount = sum('disc_amount');
    const netOfTax = sum('net_of_tax');
    const taxAmount = sum('tax_amount');
    const grossAmount = sum('gross_amount');

    // The memo can only offset as much as it's actually worth. The real system lets you
    // apply the source invoice's full total regardless of what ITEMS adds up to and saves
    // with a negative Unapplied Amount -- that's an accounting error, so this rejects it
    // (see the note above credit_memos in schema.sql).
    const submittedApply = (Array.isArray(applyLines) ? applyLines : []).filter((l) => l.sales_invoice_id && Number(l.applied_amount) > 0);
    const appliedTotal = Number(submittedApply.reduce((s, l) => s + Number(l.applied_amount), 0).toFixed(2));
    if (appliedTotal > grossAmount + 1e-9) {
      return res.status(409).json({
        error: `Applied Amount (${appliedTotal}) exceeds this Credit Memo's own total (${grossAmount}). Add the items you're crediting, or lower what you're applying.`,
      });
    }

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO credit_memos
         (credit_memo_no, sales_invoice_id, customer_id, date_created, office_location_id, ar_account_id, memo,
          subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, applied_amount, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        salesInvoiceId, si.customer_id, dateCreated || new Date().toISOString().slice(0, 10),
        officeLocationId || null, arAccountId || null, memo || null,
        subtotal, discountAmount, netOfTax, taxAmount, grossAmount, appliedTotal, req.user.id,
      ]
    );
    const memoId = result.insertId;
    await conn.query('UPDATE credit_memos SET credit_memo_no = ? WHERE id = ?', [`CM-${memoId}`, memoId]);

    for (const l of prepared) {
      await conn.query(
        `INSERT INTO credit_memo_lines
           (credit_memo_id, line_no, sales_invoice_line_id, job_order_id, item_id, item_name, description,
            department_id, quantity, units, price_per_unit, subtotal, disc_percent, disc_per_unit, disc_amount,
            disc_price_per_unit, net_of_tax, tax_code, tax_amount, gross_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          memoId, l.line_no, l.sales_invoice_line_id, l.job_order_id, l.item_id, l.item_name, l.description,
          l.department_id, l.quantity, l.units, l.price_per_unit, l.subtotal, l.disc_percent, l.disc_per_unit,
          l.disc_amount, l.disc_price_per_unit, l.net_of_tax, l.tax_code, l.tax_amount, l.gross_amount,
        ]
      );
    }

    for (const l of submittedApply) {
      await applyToInvoice(conn, l.sales_invoice_id, Number(l.applied_amount));
      await conn.query(
        'INSERT INTO credit_memo_applications (credit_memo_id, sales_invoice_id, applied_amount) VALUES (?, ?, ?)',
        [memoId, l.sales_invoice_id, l.applied_amount]
      );
    }

    await logAudit(conn, { memoId, userId: req.user.id, eventType: 'Created', fieldName: 'credit_memo_no', newValue: `CM-${memoId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM credit_memos WHERE id = ?', [memoId]);
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
    const [[cm]] = await conn.query('SELECT status FROM credit_memos WHERE id = ?', [req.params.id]);
    if (!cm) return res.status(404).json({ error: 'Not found' });
    if (cm.status === 'voided') return res.status(409).json({ error: 'This Credit Memo is already voided.' });

    // A memo already drawn on by a Customer Payment can't be unwound from here -- that
    // payment's own line would be left pointing at a credit that no longer exists. Void
    // the payment first; this reports which one rather than failing opaquely.
    const [drawnOn] = await conn.query(
      `SELECT cp.customer_payment_no FROM customer_payment_lines cpl
       JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
       WHERE cpl.credit_memo_id = ? AND cp.status != 'voided'`,
      [req.params.id]
    );
    if (drawnOn.length) {
      return res.status(409).json({
        error: `This Credit Memo has been drawn on by ${drawnOn.map((p) => p.customer_payment_no).join(', ')}. Void that payment first.`,
      });
    }

    const [applications] = await conn.query(
      'SELECT sales_invoice_id, applied_amount FROM credit_memo_applications WHERE credit_memo_id = ?',
      [req.params.id]
    );

    await conn.beginTransaction();
    for (const a of applications) {
      const [[si]] = await conn.query('SELECT amount_due FROM sales_invoices WHERE id = ?', [a.sales_invoice_id]);
      if (!si) continue;
      const newDue = Number((Number(si.amount_due) + Number(a.applied_amount)).toFixed(2));
      await conn.query(
        "UPDATE sales_invoices SET amount_due = ?, status = IF(status = 'paid_in_full' AND ? > 0.005, 'saved', status) WHERE id = ?",
        [newDue, newDue, a.sales_invoice_id]
      );
    }
    await conn.query("UPDATE credit_memos SET status = 'voided', voided_by_user_id = ?, voided_at = NOW() WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { memoId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'open', newValue: 'voided' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM credit_memos WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
