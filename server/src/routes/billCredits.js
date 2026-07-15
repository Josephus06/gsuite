const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeBillCreditGl } = require('../lib/glImpact');

const router = express.Router();
// Reached from an Open Vendor Bill's "Bill Credit" button, confirmed against the real
// system's Bill Credit modal. Unlike Vendor Bill, its lines aren't tied to the source
// bill's own inventory items -- they're general-ledger expense lines against arbitrary
// Chart of Accounts entries, then applied against one or more of the vendor's open bills.
//
// Deliberate deviation from the real system (see schema.sql comment on bill_credits for
// the full story): applied_amount here is capped at the credit's own total_amount and
// rejected (not clamped) if exceeded, rather than the real system's default of silently
// letting a small credit "apply" the source bill's entire total.
const ROUTE = '/bill-credits';

async function logAudit(conn, { creditId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('BillCredit', ?, ?, ?, ?, ?, ?)`,
    [creditId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

function computeLineAmounts({ amount, taxRate, isWithhold, wtaxRate }) {
  const taxAmount = Number((Number(amount || 0) * (Number(taxRate || 0) / 100)).toFixed(2));
  const grossAmount = Number((Number(amount || 0) + taxAmount).toFixed(2));
  const wtaxAmount = isWithhold ? Number((Number(amount || 0) * (Number(wtaxRate || 0) / 100)).toFixed(2)) : 0;
  return { tax_amount: taxAmount, gross_amount: grossAmount, wtax_amount: wtaxAmount, amount_due: Number((grossAmount - wtaxAmount).toFixed(2)) };
}

// GL Impact computation lives in server/src/lib/glImpact.js (computeBillCreditGl),
// shared with the Reports engine so the reports can never drift from what this tab shows.
const computeGlImpact = computeBillCreditGl;

async function applyToVendorBill(conn, vendorBillId, amount) {
  const [[vb]] = await conn.query('SELECT amount_due FROM vendor_bills WHERE id = ?', [vendorBillId]);
  if (!vb) throw Object.assign(new Error('One of the selected bills is no longer valid.'), { status: 400 });
  if (amount > Number(vb.amount_due) + 1e-9) {
    throw Object.assign(new Error(`Applied Amount (${amount}) exceeds this bill's remaining Amount Due (${vb.amount_due}).`), { status: 409 });
  }
  const newDue = Number((Number(vb.amount_due) - amount).toFixed(2));
  await conn.query(
    "UPDATE vendor_bills SET amount_due = ?, status = IF(? <= 0.005, 'paid_in_full', status) WHERE id = ?",
    [newDue, newDue, vendorBillId]
  );
}

async function reverseVendorBillApplication(conn, vendorBillId, amount) {
  const [[vb]] = await conn.query('SELECT amount_due FROM vendor_bills WHERE id = ?', [vendorBillId]);
  if (!vb) return;
  const newDue = Number((Number(vb.amount_due) + amount).toFixed(2));
  await conn.query(
    "UPDATE vendor_bills SET amount_due = ?, status = IF(status = 'paid_in_full' AND ? > 0.005, 'open', status) WHERE id = ?",
    [newDue, newDue, vendorBillId]
  );
}

router.get('/for-vendor-bill/:vbId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[vb]] = await pool.query(
      `SELECT vb.id, vb.bill_no, vb.office_location_id, vb.memo, vb.amount_due,
              po.supplier_id, s.name AS supplier_name
       FROM vendor_bills vb
       JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       WHERE vb.id = ?`,
      [req.params.vbId]
    );
    if (!vb) return res.status(404).json({ error: 'Not found' });

    // Pre-fills the Create Bill Credit modal's own "A/P Account" picker. This is always
    // Accounts Payable itself (a credit reduces what's owed, the same liability account
    // Vendor Bill/Sales Invoice both treat as fixed elsewhere in this build) -- it was
    // previously defaulted to the *vendor bill's own* offset account instead, which
    // would make computeGlImpact() below debit e.g. "Inventory Received Not Billed"
    // against itself rather than against AP.
    const [[apAccount]] = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '20100' LIMIT 1");
    vb.ap_account_id = apAccount?.id || null;

    const [applyLines] = await pool.query(
      `SELECT vb2.id AS vendor_bill_id, vb2.bill_no, vb2.date_created, vb2.date_due, vb2.gross_amount, vb2.amount_due
       FROM vendor_bills vb2
       JOIN purchase_orders po2 ON po2.id = vb2.purchase_order_id
       WHERE po2.supplier_id = ? AND vb2.status = 'open'
       ORDER BY vb2.id DESC`,
      [vb.supplier_id]
    );

    res.json({ ...vb, apply_lines: applyLines });
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('bc.status = ?'); params.push(status); }
    if (search) {
      where.push('(bc.bill_credit_no LIKE ? OR s.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT bc.id, bc.bill_credit_no, bc.date_created, bc.total_amount, bc.applied_amount, bc.status,
              vb.bill_no, s.name AS supplier_name
       FROM bill_credits bc
       JOIN vendor_bills vb ON vb.id = bc.vendor_bill_id
       JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       ${whereSql}
       ORDER BY bc.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[bc]] = await pool.query(
      `SELECT bc.*, vb.bill_no, s.name AS supplier_name, s.tin,
              loc.location_name AS office_location_name,
              apcoa.account_code AS ap_account_code, apcoa.account_name AS ap_account_name
       FROM bill_credits bc
       JOIN vendor_bills vb ON vb.id = bc.vendor_bill_id
       JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN locations loc ON loc.id = bc.office_location_id
       LEFT JOIN chart_of_accounts apcoa ON apcoa.id = bc.ap_account_id
       WHERE bc.id = ?`,
      [req.params.id]
    );
    if (!bc) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT bcl.*, coa.account_code, coa.account_name, d.name AS department_name, t.code AS tax_code
       FROM bill_credit_lines bcl
       LEFT JOIN chart_of_accounts coa ON coa.id = bcl.account_id
       LEFT JOIN departments d ON d.id = bcl.department_id
       LEFT JOIN taxes t ON t.id = bcl.tax_code_id
       WHERE bcl.bill_credit_id = ?`,
      [req.params.id]
    );

    const [applications] = await pool.query(
      `SELECT bca.*, vb2.bill_no
       FROM bill_credit_applications bca
       LEFT JOIN vendor_bills vb2 ON vb2.id = bca.vendor_bill_id
       WHERE bca.bill_credit_id = ?`,
      [req.params.id]
    );

    const glImpact = await computeGlImpact(bc, lines);
    res.json({ ...bc, gl_impact: glImpact, lines, applications });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'BillCredit' AND a.auditable_id = ?
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
      vendor_bill_id: vendorBillId, date_created: dateCreated, office_location_id: officeLocationId,
      ap_account_id: apAccountId, memo, wtax_id: wtaxId, expense_lines: expenseLines, apply_lines: applyLines,
    } = req.body;
    if (!vendorBillId) return res.status(400).json({ error: 'Created From (Vendor Bill) is required.' });

    const submittedExpenses = (Array.isArray(expenseLines) ? expenseLines : []).filter((l) => l.account_id && Number(l.amount) > 0);
    if (!submittedExpenses.length) return res.status(400).json({ error: 'Add at least one expense line.' });

    const taxCodeIds = [...new Set(submittedExpenses.map((l) => l.tax_code_id).filter(Boolean))];
    const taxRateById = new Map();
    if (taxCodeIds.length) {
      const [taxRows] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxCodeIds]);
      taxRows.forEach((t) => taxRateById.set(t.id, Number(t.rate)));
    }
    let wtaxRate = 0;
    let wtaxDescription = null;
    if (wtaxId) {
      const [[wt]] = await conn.query('SELECT rate, name FROM withholding_taxes WHERE id = ?', [wtaxId]);
      wtaxRate = Number(wt?.rate) || 0;
      wtaxDescription = wt?.name || null;
    }

    const computedLines = submittedExpenses.map((l) => ({
      account_id: l.account_id, department_id: l.department_id || null, amount: Number(l.amount),
      tax_code_id: l.tax_code_id || null, is_withhold: !!l.is_withhold,
      ...computeLineAmounts({ amount: l.amount, taxRate: l.tax_code_id ? taxRateById.get(l.tax_code_id) : 0, isWithhold: l.is_withhold, wtaxRate }),
    }));

    const subtotal = computedLines.reduce((s, l) => s + l.amount, 0);
    const taxAmount = computedLines.reduce((s, l) => s + l.tax_amount, 0);
    const wtaxAmount = computedLines.reduce((s, l) => s + l.wtax_amount, 0);
    const totalAmount = Number((subtotal + taxAmount).toFixed(2));

    const submittedApply = (Array.isArray(applyLines) ? applyLines : []).filter((l) => l.vendor_bill_id && Number(l.applied_amount) > 0);
    const totalApplied = submittedApply.reduce((s, l) => s + Number(l.applied_amount), 0);
    if (totalApplied > totalAmount + 1e-9) {
      return res.status(409).json({ error: `Total Applied Amount (${totalApplied.toFixed(2)}) exceeds this credit's Total Amount (${totalAmount.toFixed(2)}).` });
    }

    await conn.beginTransaction();

    for (const l of submittedApply) {
      await applyToVendorBill(conn, l.vendor_bill_id, Number(l.applied_amount));
    }

    const [result] = await conn.query(
      `INSERT INTO bill_credits
         (bill_credit_no, vendor_bill_id, date_created, office_location_id, ap_account_id, memo, wtax_id,
          wtax_description, wtax_amount, subtotal, tax_amount, total_amount, applied_amount, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vendorBillId, dateCreated || new Date().toISOString().slice(0, 10), officeLocationId || null, apAccountId || null,
        memo || null, wtaxId || null, wtaxDescription, wtaxAmount, subtotal, taxAmount, totalAmount, totalApplied, req.user.id,
      ]
    );
    const creditId = result.insertId;
    await conn.query('UPDATE bill_credits SET bill_credit_no = ? WHERE id = ?', [`BC-${creditId}`, creditId]);

    for (const l of computedLines) {
      await conn.query(
        `INSERT INTO bill_credit_lines
           (bill_credit_id, account_id, department_id, amount, tax_code_id, tax_amount, gross_amount, is_withhold, wtax_amount, amount_due)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [creditId, l.account_id, l.department_id, l.amount, l.tax_code_id, l.tax_amount, l.gross_amount, l.is_withhold, l.wtax_amount, l.amount_due]
      );
    }
    for (const l of submittedApply) {
      await conn.query(
        'INSERT INTO bill_credit_applications (bill_credit_id, vendor_bill_id, applied_amount) VALUES (?, ?, ?)',
        [creditId, l.vendor_bill_id, l.applied_amount]
      );
    }

    await logAudit(conn, { creditId, userId: req.user.id, eventType: 'Created', fieldName: 'bill_credit_no', newValue: `BC-${creditId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM bill_credits WHERE id = ?', [creditId]);
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
    const [[bc]] = await conn.query('SELECT status FROM bill_credits WHERE id = ?', [req.params.id]);
    if (!bc) return res.status(404).json({ error: 'Not found' });
    if (bc.status === 'voided') return res.status(409).json({ error: 'This Bill Credit is already voided.' });

    const [applications] = await conn.query('SELECT vendor_bill_id, applied_amount FROM bill_credit_applications WHERE bill_credit_id = ?', [req.params.id]);
    const [[usedByPayments]] = await conn.query('SELECT COUNT(*) AS n FROM bill_payment_lines WHERE bill_credit_id = ? AND applied_amount > 0', [req.params.id]);
    if (usedByPayments.n > 0) {
      return res.status(409).json({ error: 'This Bill Credit has already been used to offset a Bill Payment and cannot be voided.' });
    }

    await conn.beginTransaction();
    for (const a of applications) {
      await reverseVendorBillApplication(conn, a.vendor_bill_id, Number(a.applied_amount));
    }
    await conn.query("UPDATE bill_credits SET status = 'voided', voided_by_user_id = ?, voided_at = NOW() WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { creditId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'open', newValue: 'voided' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM bill_credits WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
