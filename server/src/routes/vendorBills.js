const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
// Reached from a Received Purchase Order's "Bill" button, confirmed against the real
// system's Create Vendor Bill modal -- the AP-side counterpart to Sales Invoice.
const ROUTE = '/vendor-bills';

async function logAudit(conn, { billId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('VendorBill', ?, ?, ?, ?, ?, ?)`,
    [billId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// price_per_unit/disc_percent/tax rate are fixed per-unit rates; Total Disc/Net of Tax/Tax
// Amt/Ext Price (gross) are always recomputed from qty x unit_price, never trusted from the
// client -- mirrors the same discipline used for Sales Invoice's billable-line amounts.
function computeLineAmounts({ unitPrice, discPercent, taxRate, qty }) {
  const subtotal = Number((Number(unitPrice || 0) * qty).toFixed(2));
  const discAmount = Number((subtotal * (Number(discPercent || 0) / 100)).toFixed(2));
  const netOfTax = Number((subtotal - discAmount).toFixed(2));
  const taxAmount = Number((netOfTax * (Number(taxRate || 0) / 100)).toFixed(2));
  const extPrice = Number((netOfTax + taxAmount).toFixed(2));
  return { subtotal, disc_amount: discAmount, net_of_tax: netOfTax, tax_amount: taxAmount, ext_price: extPrice };
}

async function recomputePoBillStatus(conn, poId) {
  const [[row]] = await conn.query(
    `SELECT SUM(CASE WHEN billed_qty >= received_qty AND received_qty > 0 THEN 1 ELSE 0 END) AS fully,
            SUM(CASE WHEN billed_qty > 0 THEN 1 ELSE 0 END) AS any_billed,
            COUNT(*) AS total
     FROM purchase_order_lines WHERE purchase_order_id = ? AND received_qty > 0`,
    [poId]
  );
  let status = 'not_billed';
  if (row.total > 0 && row.fully === row.total) status = 'fully_billed';
  else if (row.any_billed > 0) status = 'partially_billed';
  await conn.query('UPDATE purchase_orders SET bill_status = ? WHERE id = ?', [status, poId]);
}

// Powers the Create Vendor Bill modal -- only PO lines with received_qty > billed_qty show
// up ("RR Qty" > "Billed Qty" on the real screen), Qty to Bill defaulting to the full
// remaining gap. Rate is a read-only snapshot of the PO line's own rate; Unit Price defaults
// to the same value but is independently editable, matching the real modal's split fields.
router.get('/for-purchase-order/:poId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[po]] = await pool.query(
      `SELECT po.id, po.po_no, po.memo, pt.term_name, pt.no_of_days, s.name AS supplier_name
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN payment_terms pt ON pt.id = po.term_id
       WHERE po.id = ?`,
      [req.params.poId]
    );
    if (!po) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT pol.id AS purchase_order_line_id, pol.item_id, i.item_code, i.display_name AS item_name,
              pol.purchase_description, pol.location_id, loc.location_name, pol.department_id, d.name AS department_name,
              pol.received_qty, pol.billed_qty, pol.unit_title, pol.rate, pol.disc_percent,
              pol.tax_code_id, t.code AS tax_code, t.rate AS tax_rate
       FROM purchase_order_lines pol
       LEFT JOIN inventories i ON i.id = pol.item_id
       LEFT JOIN locations loc ON loc.id = pol.location_id
       LEFT JOIN departments d ON d.id = pol.department_id
       LEFT JOIN taxes t ON t.id = pol.tax_code_id
       WHERE pol.purchase_order_id = ? AND pol.received_qty > pol.billed_qty
       ORDER BY pol.id`,
      [req.params.poId]
    );

    const [[apAccount]] = await pool.query(
      "SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_name = 'Accounts Payable - Trade' LIMIT 1"
    );

    const billableLines = lines.map((l) => {
      const qty = Number(l.received_qty) - Number(l.billed_qty);
      return {
        ...l,
        rr_qty: l.received_qty,
        billed_qty: l.billed_qty,
        qty,
        unit_price: l.rate,
        ...computeLineAmounts({ unitPrice: l.rate, discPercent: l.disc_percent, taxRate: l.tax_rate, qty }),
      };
    });

    res.json({
      ...po,
      default_account: apAccount || null,
      lines: billableLines,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/by-purchase-order/:poId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, bill_no, date_created, gross_amount, status FROM vendor_bills WHERE purchase_order_id = ? ORDER BY id DESC',
      [req.params.poId]
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
    if (status) { where.push('vb.status = ?'); params.push(status); }
    if (search) {
      where.push('(vb.bill_no LIKE ? OR po.po_no LIKE ? OR s.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT vb.id, vb.bill_no, vb.date_created, vb.date_due, vb.term, vb.gross_amount, vb.amount_due, vb.status,
              po.po_no, s.name AS supplier_name, loc.location_name AS office_location_name
       FROM vendor_bills vb
       JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN locations loc ON loc.id = vb.office_location_id
       ${whereSql}
       ORDER BY vb.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[vb]] = await pool.query(
      `SELECT vb.*, po.po_no, s.name AS supplier_name,
              coa.account_code, coa.account_name,
              loc.location_name AS office_location_name,
              wt.code AS wtax_code, u.display_name AS created_by_name
       FROM vendor_bills vb
       JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN chart_of_accounts coa ON coa.id = vb.account_id
       LEFT JOIN locations loc ON loc.id = vb.office_location_id
       LEFT JOIN withholding_taxes wt ON wt.id = vb.wtax_id
       LEFT JOIN users u ON u.id = vb.created_by_user_id
       WHERE vb.id = ?`,
      [req.params.id]
    );
    if (!vb) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT vbl.*, i.item_code, i.display_name AS item_name, pol.purchase_description, pol.unit_title,
              loc.location_name, d.name AS department_name, t.code AS tax_code
       FROM vendor_bill_lines vbl
       LEFT JOIN inventories i ON i.id = vbl.item_id
       LEFT JOIN purchase_order_lines pol ON pol.id = vbl.purchase_order_line_id
       LEFT JOIN locations loc ON loc.id = vbl.location_id
       LEFT JOIN departments d ON d.id = vbl.department_id
       LEFT JOIN taxes t ON t.id = vbl.tax_code_id
       WHERE vbl.vendor_bill_id = ?`,
      [req.params.id]
    );

    res.json({ ...vb, lines });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/related', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [billPayments] = await pool.query(
      `SELECT DISTINCT bp.id, bp.bill_payment_no, bp.date_created, bp.total_amount, bp.status
       FROM bill_payments bp
       JOIN bill_payment_lines bpl ON bpl.bill_payment_id = bp.id
       WHERE bpl.vendor_bill_id = ?
       ORDER BY bp.id DESC`,
      [req.params.id]
    );
    const [billCredits] = await pool.query(
      'SELECT id, bill_credit_no, date_created, total_amount, applied_amount, status FROM bill_credits WHERE vendor_bill_id = ? ORDER BY id DESC',
      [req.params.id]
    );
    res.json({ bill_payments: billPayments, bill_credits: billCredits });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'VendorBill' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Saving marks each included PO line's billed_qty forward by exactly the qty caught up in
// *this* transaction (never the line's full received qty) -- same running-total discipline
// as Sales Invoice/Item Delivery, so cancelling a Bill can subtract exactly this back out.
// Every money figure is recomputed server-side from qty/unit_price/disc_percent/tax rate,
// never trusted from the client's live-recalculated display values.
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      purchase_order_id: purchaseOrderId, date_created: dateCreated, date_due: dateDue, term,
      reference_no: referenceNo, account_id: accountId, office_location_id: officeLocationId, memo,
      wtax_id: wtaxId, lines: submittedLines,
    } = req.body;
    if (!purchaseOrderId) return res.status(400).json({ error: 'Purchase Order is required.' });

    const submitted = (Array.isArray(submittedLines) ? submittedLines : [])
      .filter((l) => l.purchase_order_line_id && Number(l.qty) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Include at least one item.' });

    const lineIds = submitted.map((l) => Number(l.purchase_order_line_id));
    const [poLines] = await conn.query(
      `SELECT pol.id, pol.item_id, pol.location_id, pol.department_id, pol.received_qty, pol.billed_qty,
              pol.rate, pol.tax_code_id, t.rate AS tax_rate
       FROM purchase_order_lines pol
       LEFT JOIN taxes t ON t.id = pol.tax_code_id
       WHERE pol.purchase_order_id = ? AND pol.id IN (?)`,
      [purchaseOrderId, lineIds]
    );
    if (poLines.length !== lineIds.length) return res.status(400).json({ error: 'One of the selected items is no longer eligible.' });
    const poLineById = new Map(poLines.map((l) => [l.id, l]));

    let wtaxRate = 0;
    if (wtaxId) {
      const [[wt]] = await conn.query('SELECT rate FROM withholding_taxes WHERE id = ?', [wtaxId]);
      wtaxRate = Number(wt?.rate) || 0;
    }

    const computedLines = [];
    for (const s of submitted) {
      const poLine = poLineById.get(Number(s.purchase_order_line_id));
      const qty = Number(s.qty);
      const remaining = Number(poLine.received_qty) - Number(poLine.billed_qty);
      // Reject rather than clamp -- a Qty to Bill beyond what was actually received is a
      // real data-entry error, not something to silently cap.
      if (qty > remaining + 1e-9) {
        return res.status(409).json({ error: `Qty to Bill (${qty}) exceeds the remaining billable qty (${remaining}) for this line.` });
      }
      const unitPrice = s.unit_price !== undefined ? Number(s.unit_price) : Number(poLine.rate);
      const discPercent = Number(s.disc_percent || 0);
      const isWithhold = !!s.is_withhold;
      const amounts = computeLineAmounts({ unitPrice, discPercent, taxRate: poLine.tax_rate, qty });
      const lineWtaxAmount = isWithhold ? Number((amounts.net_of_tax * wtaxRate / 100).toFixed(2)) : 0;
      computedLines.push({
        purchase_order_line_id: poLine.id, item_id: poLine.item_id, location_id: poLine.location_id,
        department_id: poLine.department_id, qty, rate: poLine.rate, unit_price: unitPrice, disc_percent: discPercent,
        tax_code_id: poLine.tax_code_id, is_withhold: isWithhold, wtax_amount: lineWtaxAmount,
        amount_due: Number((amounts.ext_price - lineWtaxAmount).toFixed(2)), ...amounts,
      });
    }

    const subtotal = computedLines.reduce((s, l) => s + l.subtotal, 0);
    const discountAmount = computedLines.reduce((s, l) => s + l.disc_amount, 0);
    const netOfTax = computedLines.reduce((s, l) => s + l.net_of_tax, 0);
    const taxAmount = computedLines.reduce((s, l) => s + l.tax_amount, 0);
    const grossAmount = computedLines.reduce((s, l) => s + l.ext_price, 0);
    const wtaxAmount = computedLines.reduce((s, l) => s + l.wtax_amount, 0);
    const amountDue = grossAmount - wtaxAmount;

    let wtaxDescription = null;
    if (wtaxId) {
      const [[wt]] = await conn.query('SELECT name FROM withholding_taxes WHERE id = ?', [wtaxId]);
      wtaxDescription = wt?.name || null;
    }

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO vendor_bills
         (bill_no, purchase_order_id, date_created, date_due, term, reference_no, account_id, office_location_id,
          memo, subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, wtax_id, wtax_description,
          wtax_amount, amount_due, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        purchaseOrderId, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null, term || null,
        referenceNo || null, accountId || null, officeLocationId || null, memo || null,
        subtotal, discountAmount, netOfTax, taxAmount, grossAmount, wtaxId || null, wtaxDescription,
        wtaxAmount, amountDue, req.user.id,
      ]
    );
    const billId = result.insertId;
    // The record itself is always a "Vendor Bill" (VB-#), matching the real system.
    await conn.query('UPDATE vendor_bills SET bill_no = ? WHERE id = ?', [`VB-${billId}`, billId]);

    for (const l of computedLines) {
      await conn.query(
        `INSERT INTO vendor_bill_lines
           (vendor_bill_id, purchase_order_line_id, item_id, location_id, department_id, qty, rate, unit_price,
            disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price, is_withhold, wtax_amount, amount_due)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          billId, l.purchase_order_line_id, l.item_id, l.location_id, l.department_id, l.qty, l.rate, l.unit_price,
          l.disc_percent, l.disc_amount, l.net_of_tax, l.tax_code_id, l.tax_amount, l.ext_price, l.is_withhold,
          l.wtax_amount, l.amount_due,
        ]
      );
      await conn.query(
        'UPDATE purchase_order_lines SET billed_qty = billed_qty + ? WHERE id = ?',
        [l.qty, l.purchase_order_line_id]
      );
    }

    await recomputePoBillStatus(conn, purchaseOrderId);
    await logAudit(conn, { billId, userId: req.user.id, eventType: 'Created', fieldName: 'bill_no', newValue: `VB-${billId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM vendor_bills WHERE id = ?', [billId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[vb]] = await conn.query('SELECT status, purchase_order_id FROM vendor_bills WHERE id = ?', [req.params.id]);
    if (!vb) return res.status(404).json({ error: 'Not found' });
    if (vb.status === 'cancelled') return res.status(409).json({ error: 'This Vendor Bill is already cancelled.' });

    const [lines] = await conn.query('SELECT purchase_order_line_id, qty FROM vendor_bill_lines WHERE vendor_bill_id = ?', [req.params.id]);

    await conn.beginTransaction();
    for (const l of lines) {
      await conn.query('UPDATE purchase_order_lines SET billed_qty = GREATEST(billed_qty - ?, 0) WHERE id = ?', [l.qty, l.purchase_order_line_id]);
    }
    await conn.query(
      "UPDATE vendor_bills SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    await recomputePoBillStatus(conn, vb.purchase_order_id);
    await logAudit(conn, { billId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'open', newValue: 'cancelled' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM vendor_bills WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
