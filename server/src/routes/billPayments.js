const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
// Reached from an Open Vendor Bill's "Bill Payment" button, confirmed against the real
// system's Bill Payment modal. A single payment can settle several of the same vendor's
// open bills at once (the "Apply" tab) and/or offset the payment with the vendor's own
// existing open Bill Credits (the "Debits" tab).
const ROUTE = '/bill-payments';

async function logAudit(conn, { paymentId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('BillPayment', ?, ?, ?, ?, ?, ?)`,
    [paymentId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

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
  const [[vb]] = await conn.query('SELECT amount_due, gross_amount FROM vendor_bills WHERE id = ?', [vendorBillId]);
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
      `SELECT vb.id, vb.bill_no, vb.office_location_id, vb.account_id AS ap_account_id, vb.memo,
              po.supplier_id, s.name AS supplier_name, coa.account_code, coa.account_name
       FROM vendor_bills vb
       JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN chart_of_accounts coa ON coa.id = vb.account_id
       WHERE vb.id = ?`,
      [req.params.vbId]
    );
    if (!vb) return res.status(404).json({ error: 'Not found' });

    const [applyLines] = await pool.query(
      `SELECT vb2.id AS vendor_bill_id, vb2.bill_no, vb2.date_created, vb2.date_due, vb2.gross_amount, vb2.amount_due
       FROM vendor_bills vb2
       JOIN purchase_orders po2 ON po2.id = vb2.purchase_order_id
       WHERE po2.supplier_id = ? AND vb2.status = 'open'
       ORDER BY vb2.id DESC`,
      [vb.supplier_id]
    );

    const [debitLines] = await pool.query(
      `SELECT id AS bill_credit_id, bill_credit_no, date_created, total_amount, applied_amount,
              (total_amount - applied_amount) AS remaining
       FROM bill_credits
       WHERE vendor_bill_id IN (SELECT vb3.id FROM vendor_bills vb3 JOIN purchase_orders po3 ON po3.id = vb3.purchase_order_id WHERE po3.supplier_id = ?)
         AND status = 'open' AND applied_amount < total_amount
       ORDER BY id DESC`,
      [vb.supplier_id]
    );

    res.json({ ...vb, apply_lines: applyLines, debit_lines: debitLines });
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('bp.status = ?'); params.push(status); }
    if (search) {
      where.push('(bp.bill_payment_no LIKE ? OR s.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT bp.id, bp.bill_payment_no, bp.date_created, bp.payment_method_id, pm.name AS payment_method_name,
              bp.total_amount, bp.status, s.name AS supplier_name
       FROM bill_payments bp
       LEFT JOIN suppliers s ON s.id = bp.supplier_id
       LEFT JOIN payment_methods pm ON pm.id = bp.payment_method_id
       ${whereSql}
       ORDER BY bp.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[bp]] = await pool.query(
      `SELECT bp.*, s.name AS supplier_name, s.tin,
              loc.location_name AS office_location_name,
              apcoa.account_code AS ap_account_code, apcoa.account_name AS ap_account_name,
              bankcoa.account_code AS bank_account_code, bankcoa.account_name AS bank_account_name,
              pm.name AS payment_method_name
       FROM bill_payments bp
       LEFT JOIN suppliers s ON s.id = bp.supplier_id
       LEFT JOIN locations loc ON loc.id = bp.office_location_id
       LEFT JOIN chart_of_accounts apcoa ON apcoa.id = bp.ap_account_id
       LEFT JOIN chart_of_accounts bankcoa ON bankcoa.id = bp.bank_account_id
       LEFT JOIN payment_methods pm ON pm.id = bp.payment_method_id
       WHERE bp.id = ?`,
      [req.params.id]
    );
    if (!bp) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT bpl.*, vb.bill_no, vb.date_created AS vb_date_created, vb.date_due AS vb_date_due, vb.gross_amount AS vb_gross_amount,
              bc.bill_credit_no
       FROM bill_payment_lines bpl
       LEFT JOIN vendor_bills vb ON vb.id = bpl.vendor_bill_id
       LEFT JOIN bill_credits bc ON bc.id = bpl.bill_credit_id
       WHERE bpl.bill_payment_id = ?`,
      [req.params.id]
    );

    res.json({ ...bp, lines });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'BillPayment' AND a.auditable_id = ?
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
      supplier_id: supplierId, date_created: dateCreated, payment_type: paymentType, payee_name: payeeName,
      office_location_id: officeLocationId, ap_account_id: apAccountId, bank_account_id: bankAccountId,
      payment_method_id: paymentMethodId, reference_no: referenceNo, check_date: checkDate, check_no: checkNo,
      memo, apply_lines: applyLines, debit_lines: debitLines,
    } = req.body;

    if (!supplierId) return res.status(400).json({ error: 'Vendor is required.' });
    if (!bankAccountId || !paymentMethodId) return res.status(400).json({ error: 'Bank Account and Payment Method are required.' });

    const submittedApply = (Array.isArray(applyLines) ? applyLines : []).filter((l) => l.vendor_bill_id && Number(l.applied_amount) > 0);
    const submittedDebits = (Array.isArray(debitLines) ? debitLines : []).filter((l) => l.bill_credit_id && Number(l.applied_amount) > 0);
    if (!submittedApply.length && !submittedDebits.length) {
      return res.status(400).json({ error: 'Apply at least one amount to a bill or credit.' });
    }

    // Re-check every line against fresh amount_due/remaining -- reject rather than clamp,
    // matching the qty/amount-cap discipline used everywhere else in this codebase.
    for (const l of submittedDebits) {
      const [[bc]] = await conn.query('SELECT total_amount, applied_amount, status FROM bill_credits WHERE id = ?', [l.bill_credit_id]);
      if (!bc || bc.status !== 'open') return res.status(400).json({ error: 'One of the selected credits is no longer valid.' });
      const remaining = Number(bc.total_amount) - Number(bc.applied_amount);
      if (Number(l.applied_amount) > remaining + 1e-9) {
        return res.status(409).json({ error: `Applied Amount (${l.applied_amount}) exceeds this credit's remaining balance (${remaining}).` });
      }
    }

    const totalAmount = [...submittedApply, ...submittedDebits].reduce((s, l) => s + Number(l.applied_amount), 0);

    await conn.beginTransaction();

    for (const l of submittedApply) {
      await applyToVendorBill(conn, l.vendor_bill_id, Number(l.applied_amount));
    }
    for (const l of submittedDebits) {
      await conn.query('UPDATE bill_credits SET applied_amount = applied_amount + ? WHERE id = ?', [Number(l.applied_amount), l.bill_credit_id]);
    }

    const [result] = await conn.query(
      `INSERT INTO bill_payments
         (bill_payment_no, date_created, payment_type, supplier_id, payee_name, office_location_id, ap_account_id,
          bank_account_id, payment_method_id, reference_no, check_date, check_no, memo, total_amount, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dateCreated || new Date().toISOString().slice(0, 10), paymentType || 'full', supplierId, payeeName || null,
        officeLocationId || null, apAccountId || null, bankAccountId, paymentMethodId, referenceNo || null,
        checkDate || null, checkNo || null, memo || null, totalAmount, req.user.id,
      ]
    );
    const paymentId = result.insertId;
    await conn.query('UPDATE bill_payments SET bill_payment_no = ? WHERE id = ?', [`BPAY-${paymentId}`, paymentId]);

    for (const l of submittedApply) {
      await conn.query(
        'INSERT INTO bill_payment_lines (bill_payment_id, vendor_bill_id, applied_amount) VALUES (?, ?, ?)',
        [paymentId, l.vendor_bill_id, l.applied_amount]
      );
    }
    for (const l of submittedDebits) {
      await conn.query(
        'INSERT INTO bill_payment_lines (bill_payment_id, bill_credit_id, applied_amount) VALUES (?, ?, ?)',
        [paymentId, l.bill_credit_id, l.applied_amount]
      );
    }

    await logAudit(conn, { paymentId, userId: req.user.id, eventType: 'Created', fieldName: 'bill_payment_no', newValue: `BPAY-${paymentId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM bill_payments WHERE id = ?', [paymentId]);
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
    const [[bp]] = await conn.query('SELECT status FROM bill_payments WHERE id = ?', [req.params.id]);
    if (!bp) return res.status(404).json({ error: 'Not found' });
    if (bp.status === 'voided') return res.status(409).json({ error: 'This Bill Payment is already voided.' });

    const [lines] = await conn.query('SELECT vendor_bill_id, bill_credit_id, applied_amount FROM bill_payment_lines WHERE bill_payment_id = ?', [req.params.id]);

    await conn.beginTransaction();
    for (const l of lines) {
      if (l.vendor_bill_id) await reverseVendorBillApplication(conn, l.vendor_bill_id, Number(l.applied_amount));
      if (l.bill_credit_id) await conn.query('UPDATE bill_credits SET applied_amount = GREATEST(applied_amount - ?, 0) WHERE id = ?', [Number(l.applied_amount), l.bill_credit_id]);
    }
    await conn.query("UPDATE bill_payments SET status = 'voided', voided_by_user_id = ?, voided_at = NOW() WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { paymentId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'open', newValue: 'voided' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM bill_payments WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
