const express = require('express');
const pool = require('../db');
const { insertNumbered } = require('../lib/docNumber');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { computeVendorBillGl } = require('../lib/glImpact');

const router = express.Router();
// Reached from a Received Purchase Order's "Bill" button, confirmed against the real
// system's Create Vendor Bill modal -- the AP-side counterpart to Sales Invoice.
//
// Or raised on its own (Create New on the list) as a STANDALONE expense bill: a supplier's bill
// with no PO behind it -- rent, utilities, freight, fees. Its supplier is vendor_bills.supplier_id
// and each line debits an expense account instead of billing a received PO line.
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

// GL Impact computation lives in server/src/lib/glImpact.js (computeVendorBillGl),
// shared with the Reports engine so the reports can never drift from what this tab shows.
const computeGlImpact = computeVendorBillGl;

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
              pol.received_qty, pol.billed_qty, pol.unit_title, pol.purchase_unit, pol.rate, pol.disc_percent,
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

    // Pre-fills the Create Vendor Bill modal's own Account picker. This is the bill's
    // debit-side offset account -- Accounts Payable itself is always the fixed credit
    // leg in computeGlImpact() below, never user-selected, so defaulting this picker to
    // AP-Trade was wrong (it made every bill created from this modal double-book AP on
    // both sides unless someone thought to change it). "Inventory Received Not Billed"
    // is the real system's actual default for a PO-linked bill -- the 3-way-match
    // clearing account credited when the goods were received, debited back out here.
    const [[defaultAccount]] = await pool.query(
      "SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code = '20300' LIMIT 1"
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

    // For lines whose PO line has no department -- the bill must be given one (see POST /).
    // Sent here rather than read from /lookups, which the people billing may not be granted.
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    res.json({
      ...po,
      default_account: defaultAccount || null,
      lines: billableLines,
      departments,
    });
  } catch (err) {
    next(err);
  }
});

// What the standalone bill form picks from, under this page's own can_view.
router.get('/standalone-meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [suppliers] = await pool.query(
      `SELECT s.id, s.name, s.supplier_code, s.tin, COALESCE(pt.term_name, s.credit_term) AS term_name, COALESCE(pt.no_of_days, s.term_days) AS no_of_days
         FROM suppliers s LEFT JOIN payment_terms pt ON pt.id = s.payment_term_id
        WHERE s.is_active = 1 ORDER BY s.name`
    );
    const [accounts] = await pool.query(
      `SELECT coa.id, coa.account_code, coa.account_name, coa.account_type
         FROM chart_of_accounts coa
        -- Every postable (non-summary) account, the same list Cheques and Journals offer. is_active is
        -- not a usable filter here: 236 real accounts, Accounts Payable among them, carry 0.
        WHERE (coa.is_summary = 0 OR coa.is_summary IS NULL) ORDER BY coa.account_code`
    );
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    const [taxes] = await pool.query('SELECT id, code, rate FROM taxes ORDER BY code');
    const [wtaxes] = await pool.query('SELECT id, code, name, rate FROM withholding_taxes WHERE is_active = 1 ORDER BY code, rate');
    const [[ap]] = await pool.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code = '20100' LIMIT 1");
    res.json({ suppliers, accounts, departments, taxes, wtaxes, ap_account: ap || null });
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
       LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id)
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
       LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id)
       LEFT JOIN chart_of_accounts coa ON coa.id = vb.account_id
       LEFT JOIN locations loc ON loc.id = vb.office_location_id
       LEFT JOIN withholding_taxes wt ON wt.id = vb.wtax_id
       LEFT JOIN users u ON u.id = vb.created_by_user_id
       WHERE vb.id = ?`,
      [req.params.id]
    );
    if (!vb) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT vbl.*, i.item_code, COALESCE(i.display_name, vbl.description) AS item_name,
              COALESCE(pol.purchase_description, vbl.description) AS purchase_description, pol.unit_title, pol.purchase_unit,
              loc.location_name, d.name AS department_name, t.code AS tax_code,
              lcoa.account_code AS line_account_code, lcoa.account_name AS line_account_name
       FROM vendor_bill_lines vbl
       LEFT JOIN chart_of_accounts lcoa ON lcoa.id = vbl.account_id
       LEFT JOIN inventories i ON i.id = vbl.item_id
       LEFT JOIN purchase_order_lines pol ON pol.id = vbl.purchase_order_line_id
       LEFT JOIN locations loc ON loc.id = vbl.location_id
       LEFT JOIN departments d ON d.id = vbl.department_id
       LEFT JOIN taxes t ON t.id = vbl.tax_code_id
       WHERE vbl.vendor_bill_id = ?`,
      [req.params.id]
    );

    const glImpact = await computeGlImpact(vb, lines);
    res.json({ ...vb, gl_impact: glImpact, lines });
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
// A standalone expense bill. Same money discipline as the PO path -- every figure computed here
// from qty x unit price, discount, the tax code's rate and the withholding rate -- but each line
// names the expense account it debits and a description, instead of billing a received PO line.
// Every line needs a department, as on the PO path, so department budgets see the spending.
async function createStandaloneBill(req, res, conn) {
  const {
    supplier_id: supplierId, date_created: dateCreated, date_due: dateDue, term, reference_no: referenceNo,
    office_location_id: officeLocationId, memo, wtax_id: wtaxId, lines: submittedLines, account_id: apAccountId,
  } = req.body;
  // The header Account on the source's form: the payable the bill credits -- Accounts Payable - Trade
  // unless another is chosen. (On a PO bill account_id is the debit offset instead; see glImpact.)
  const [[apAcct]] = apAccountId
    ? await conn.query('SELECT id FROM chart_of_accounts WHERE id = ?', [apAccountId])
    : await conn.query("SELECT id FROM chart_of_accounts WHERE account_code = '20100' LIMIT 1");

  const [[supplier]] = await conn.query('SELECT id, name FROM suppliers WHERE id = ?', [supplierId]);
  if (!supplier) return res.status(400).json({ error: 'Choose a supplier.' });
  const submitted = (Array.isArray(submittedLines) ? submittedLines : []).filter((l) => Number(l.qty) > 0);
  if (!submitted.length) return res.status(400).json({ error: 'Add at least one line with a quantity.' });
  await assertPeriodOpen(dateCreated, 'ap', conn);

  const accountIds = [...new Set(submitted.map((l) => Number(l.account_id)).filter(Boolean))];
  const [accts] = accountIds.length ? await conn.query('SELECT id FROM chart_of_accounts WHERE id IN (?)', [accountIds]) : [[]];
  const knownAcct = new Set(accts.map((a) => a.id));
  const [taxes] = await conn.query('SELECT id, rate FROM taxes');
  const taxRate = new Map(taxes.map((t) => [t.id, Number(t.rate)]));

  let wtaxRate = 0;
  let wtaxDescription = null;
  if (wtaxId) {
    const [[wt]] = await conn.query('SELECT name, rate FROM withholding_taxes WHERE id = ?', [wtaxId]);
    wtaxRate = Number(wt?.rate) || 0;
    wtaxDescription = wt?.name || null;
  }

  const computedLines = [];
  for (const [idx, l] of submitted.entries()) {
    if (!knownAcct.has(Number(l.account_id))) return res.status(400).json({ error: `Choose an account on line ${idx + 1}.` });
    if (!Number(l.department_id)) return res.status(400).json({ error: `Choose a Department on line ${idx + 1}. It is required so department budgets can be tracked.` });
    const qty = Number(l.qty);
    const unitPrice = Number(l.unit_price);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) return res.status(400).json({ error: `Enter an amount on line ${idx + 1}.` });
    const amounts = computeLineAmounts({ unitPrice, discPercent: l.disc_percent, taxRate: taxRate.get(Number(l.tax_code_id)) || 0, qty });
    const isWithhold = !!l.is_withhold && wtaxRate > 0;
    const lineWtaxAmount = isWithhold ? Number((amounts.net_of_tax * wtaxRate / 100).toFixed(2)) : 0;
    computedLines.push({
      account_id: Number(l.account_id), description: String(l.description || '').trim().slice(0, 500) || null,
      department_id: Number(l.department_id), location_id: Number(l.location_id) || null, qty, rate: unitPrice, unit_price: unitPrice,
      disc_percent: Number(l.disc_percent || 0), tax_code_id: Number(l.tax_code_id) || null, is_withhold: isWithhold,
      wtax_amount: lineWtaxAmount, amount_due: Number((amounts.ext_price - lineWtaxAmount).toFixed(2)), ...amounts,
    });
  }

  const subtotal = computedLines.reduce((sum, l) => sum + l.subtotal, 0);
  const discountAmount = computedLines.reduce((sum, l) => sum + l.disc_amount, 0);
  const netOfTax = computedLines.reduce((sum, l) => sum + l.net_of_tax, 0);
  const taxAmount = computedLines.reduce((sum, l) => sum + l.tax_amount, 0);
  const grossAmount = computedLines.reduce((sum, l) => sum + l.ext_price, 0);
  const wtaxAmount = computedLines.reduce((sum, l) => sum + l.wtax_amount, 0);
  const amountDue = Number((grossAmount - wtaxAmount).toFixed(2));

  await conn.beginTransaction();
  const { id: billId, no: billNo } = await insertNumbered(conn, {
    table: 'vendor_bills',
    column: 'bill_no',
    prefix: 'VB-',
    run: (no) => conn.query(
      `INSERT INTO vendor_bills
         (bill_no, purchase_order_id, supplier_id, date_created, date_due, term, reference_no, account_id, office_location_id,
          memo, subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, wtax_id, wtax_description,
          wtax_amount, amount_due, created_by_user_id)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        no, supplier.id, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null, term || null,
        referenceNo || null, apAcct ? apAcct.id : null, officeLocationId || null, memo || null,
        subtotal, discountAmount, netOfTax, taxAmount, grossAmount, wtaxId || null, wtaxDescription,
        wtaxAmount, amountDue, req.user.id,
      ]
    ),
  });

  for (const l of computedLines) {
    await conn.query(
      `INSERT INTO vendor_bill_lines
         (vendor_bill_id, purchase_order_line_id, item_id, account_id, description, location_id, department_id, qty, rate, unit_price,
          disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price, is_withhold, wtax_amount, amount_due)
       VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        billId, l.account_id, l.description, l.location_id, l.department_id, l.qty, l.rate, l.unit_price,
        l.disc_percent, l.disc_amount, l.net_of_tax, l.tax_code_id, l.tax_amount, l.ext_price, l.is_withhold,
        l.wtax_amount, l.amount_due,
      ]
    );
  }

  await logAudit(conn, { billId, userId: req.user.id, eventType: 'Created', fieldName: 'bill_no', newValue: billNo || `VB-${billId}` });
  await logAudit(conn, { billId, userId: req.user.id, eventType: 'Created', fieldName: 'supplier_id', newValue: supplier.name });
  await conn.commit();

  const [[row]] = await pool.query('SELECT * FROM vendor_bills WHERE id = ?', [billId]);
  return res.status(201).json(row);
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      purchase_order_id: purchaseOrderId, date_created: dateCreated, date_due: dateDue, term,
      reference_no: referenceNo, account_id: accountId, office_location_id: officeLocationId, memo,
      wtax_id: wtaxId, lines: submittedLines,
    } = req.body;
    // No PO: a standalone expense bill -- supplier + account lines.
    if (!purchaseOrderId && req.body.supplier_id) return createStandaloneBill(req, res, conn);
    if (!purchaseOrderId) return res.status(400).json({ error: 'Purchase Order is required.' });

    const submitted = (Array.isArray(submittedLines) ? submittedLines : [])
      .filter((l) => l.purchase_order_line_id && Number(l.qty) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Include at least one item.' });
    await assertPeriodOpen(dateCreated, 'ap', conn);

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
        // The PO line's department, or -- where the PO never had one -- the one chosen on the bill.
        department_id: poLine.department_id || Number(s.department_id) || null, qty, rate: poLine.rate, unit_price: unitPrice, disc_percent: discPercent,
        tax_code_id: poLine.tax_code_id, is_withhold: isWithhold, wtax_amount: lineWtaxAmount,
        amount_due: Number((amounts.ext_price - lineWtaxAmount).toFixed(2)), ...amounts,
      });
    }

    // Every bill line needs a department so department budgets see the spending (see
    // lib/requireDepartment.js). Bills are items, so unlike cheques and journals there is no
    // balance-sheet line to exempt.
    const noDept = computedLines.findIndex((l) => !l.department_id);
    if (noDept >= 0) return res.status(400).json({ error: `Choose a Department on line ${noDept + 1}. Its Purchase Order line has none, and it is required so department budgets can be tracked.` });

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
    // The record itself is always a "Vendor Bill" (VB-#), matching the real system.
    const { id: billId } = await insertNumbered(conn, {
      table: 'vendor_bills',
      column: 'bill_no',
      prefix: 'VB-',
      run: (no) => conn.query(
        `INSERT INTO vendor_bills
           (bill_no, purchase_order_id, date_created, date_due, term, reference_no, account_id, office_location_id,
            memo, subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, wtax_id, wtax_description,
            wtax_amount, amount_due, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          no, purchaseOrderId, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null, term || null,
          referenceNo || null, accountId || null, officeLocationId || null, memo || null,
          subtotal, discountAmount, netOfTax, taxAmount, grossAmount, wtaxId || null, wtaxDescription,
          wtaxAmount, amountDue, req.user.id,
        ]
      ),
    });

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

router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[vb]] = await conn.query('SELECT status, purchase_order_id, date_created FROM vendor_bills WHERE id = ?', [req.params.id]);
    if (vb) await assertPeriodOpen(vb.date_created, 'ap', conn);
    if (!vb) return res.status(404).json({ error: 'Not found' });
    if (vb.status === 'cancelled') return res.status(409).json({ error: 'This Vendor Bill is already cancelled.' });

    const [lines] = await conn.query('SELECT purchase_order_line_id, qty FROM vendor_bill_lines WHERE vendor_bill_id = ?', [req.params.id]);

    await conn.beginTransaction();
    for (const l of lines) {
      if (!l.purchase_order_line_id) continue; // an expense line billed nothing off a PO
      await conn.query('UPDATE purchase_order_lines SET billed_qty = GREATEST(billed_qty - ?, 0) WHERE id = ?', [l.qty, l.purchase_order_line_id]);
    }
    await conn.query(
      "UPDATE vendor_bills SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    if (vb.purchase_order_id) await recomputePoBillStatus(conn, vb.purchase_order_id);
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
