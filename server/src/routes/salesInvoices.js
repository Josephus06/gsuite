const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeSalesOrderStatus } = require('../lib/salesOrderStatus');
const { computeSalesInvoiceGl } = require('../lib/glImpact');

const router = express.Router();
// Unlike Item Fulfillment/Receipt/Quality Inspection/Item Delivery (all reached only by
// drilling into a parent record and reusing its permission scope), Sales Invoices also
// get their own standalone "Saved Invoices" list page -- so this is a real page entry
// (route '/sales-invoices'), not a borrowed scope.
const ROUTE = '/sales-invoices';

// GL Impact computation lives in server/src/lib/glImpact.js (computeSalesInvoiceGl),
// shared with the Reports engine so the reports can never drift from what this tab shows.
const computeGlImpact = computeSalesInvoiceGl;

async function logAudit(conn, { invoiceId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('SalesInvoice', ?, ?, ?, ?, ?, ?)`,
    [invoiceId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Mirrors the real system's "Saved Invoices" list -- flat (no status tabs, just a
// Status filter), same pattern as Assembly Builds' list.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status, customer_id: customerId, sales_rep_id: salesRepId } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('si.status = ?'); params.push(status); }
    if (customerId) { where.push('so.customer_id = ?'); params.push(customerId); }
    if (salesRepId) { where.push('si.sales_rep_id = ?'); params.push(salesRepId); }
    if (search) {
      where.push('(si.invoice_no LIKE ? OR so.sales_order_no LIKE ? OR c.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT si.id, si.invoice_no, si.date_created, si.date_due, si.net_of_tax, si.tax_amount,
              si.gross_amount, si.amount_due, si.bs_si_no, si.term, si.status, si.memo,
              so.sales_order_no, c.name AS customer_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name, d.name AS department_name
       FROM sales_invoices si
       JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees sr ON sr.id = si.sales_rep_id
       LEFT JOIN locations loc ON loc.id = si.office_location_id
       LEFT JOIN departments d ON d.id = si.department_id
       ${whereSql}
       ORDER BY si.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Every line's price_per_unit/disc_percent/tax rate are fixed per-unit rates set once on
// the Sales Order line -- so billing only part of a line (Delivered minus already-Invoiced,
// which can be less than the line's full ordered Qty when its JO isn't fully built/QI'd
// yet) means recomputing Subtotal/Disc Amt/Net of Tax/Tax Amt/Gross Amt from that billable
// qty, not copying the full-line totals that were computed against the *ordered* qty.
function computeBillableLineAmounts({ pricePerUnit, discPercent, taxRate, billableQty }) {
  const subtotal = Number((Number(pricePerUnit || 0) * billableQty).toFixed(2));
  const discAmount = Number((subtotal * (Number(discPercent || 0) / 100)).toFixed(2));
  const netOfTax = Number((subtotal - discAmount).toFixed(2));
  const taxAmount = Number((netOfTax * (Number(taxRate || 0) / 100)).toFixed(2));
  const grossAmount = Number((netOfTax + taxAmount).toFixed(2));
  return { subtotal, disc_amount: discAmount, net_of_tax: netOfTax, tax_amount: taxAmount, gross_amount: grossAmount };
}

// Powers the Create SI form -- only SO lines with a JO that's been delivered but not
// yet (fully) invoiced show up (quantity_delivered > quantity_invoiced), each one billed
// for exactly the still-uninvoiced delivered qty (which can be less than the line's full
// ordered Qty), with Subtotal/Disc/Net/Tax/Gross recomputed against that qty.
router.get('/for-sales-order/:salesOrderId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[so]] = await pool.query(
      `SELECT so.id, so.sales_order_no, so.credit_term, so.sales_rep_id, so.office_location_id, so.shipping_address,
              c.name AS customer_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name
       FROM sales_orders so
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN locations loc ON loc.id = so.office_location_id
       WHERE so.id = ?`,
      [req.params.salesOrderId]
    );
    if (!so) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT sol.id AS sales_order_line_id, sol.job_order_id, jo.job_order_no, jt.display_name AS item_name,
              sol.description, sol.job_location_id, loc.location_name AS job_location_name,
              sol.quantity AS ordered_quantity, sol.units, sol.price_per_unit, sol.disc_percent,
              sol.disc_price_per_unit, t.code AS tax_code, t.rate AS tax_rate,
              jo.quantity_delivered, jo.quantity_invoiced
       FROM sales_order_lines sol
       JOIN job_orders jo ON jo.id = sol.job_order_id
       LEFT JOIN job_types jt ON jt.id = sol.job_type_id
       LEFT JOIN locations loc ON loc.id = sol.job_location_id
       LEFT JOIN taxes t ON t.id = sol.tax_code_id
       WHERE sol.sales_order_id = ? AND jo.quantity_delivered > jo.quantity_invoiced
       ORDER BY sol.line_no`,
      [req.params.salesOrderId]
    );

    const billableLines = lines.map((l) => {
      const billableQty = Number(l.quantity_delivered) - Number(l.quantity_invoiced);
      return {
        ...l,
        quantity: billableQty,
        ...computeBillableLineAmounts({
          pricePerUnit: l.price_per_unit, discPercent: l.disc_percent, taxRate: l.tax_rate, billableQty,
        }),
      };
    });

    res.json({ ...so, lines: billableLines });
  } catch (err) {
    next(err);
  }
});

// Powers Create SI when it was reached from a Delivery Ticket's own Bill > SI button
// rather than from the Sales Order. The invoice bills exactly what the ticket says --
// its stored lines, ad-hoc "Add Item" charges included -- so nothing is recomputed from
// the Sales Order's delivered-vs-invoiced gap here. The ticket already decided the
// amounts; billing it is what makes them official.
router.get('/for-delivery-ticket/:deliveryTicketId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[dt]] = await pool.query(
      `SELECT dt.id AS delivery_ticket_id, dt.dt_no, dt.status, dt.sales_order_id, dt.term, dt.po_no,
              dt.sales_rep_id, dt.office_location_id, dt.department_id, dt.memo,
              so.sales_order_no, so.shipping_address, so.credit_term,
              c.name AS customer_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name, d.name AS department_name
       FROM delivery_tickets dt
       JOIN sales_orders so ON so.id = dt.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees sr ON sr.id = dt.sales_rep_id
       LEFT JOIN locations loc ON loc.id = dt.office_location_id
       LEFT JOIN departments d ON d.id = dt.department_id
       WHERE dt.id = ?`,
      [req.params.deliveryTicketId]
    );
    if (!dt) return res.status(404).json({ error: 'Not found' });
    if (dt.status === 'void') return res.status(409).json({ error: 'This Delivery Ticket is void and cannot be billed.' });
    if (dt.status === 'converted') return res.status(409).json({ error: 'This Delivery Ticket has already been converted to an Invoice.' });

    const [lines] = await pool.query(
      `SELECT dtl.id AS delivery_ticket_line_id, dtl.sales_order_line_id, dtl.job_order_id, jo.job_order_no,
              dtl.item_name, dtl.description, dtl.location_id AS job_location_id, loc.location_name AS job_location_name,
              dtl.quantity, dtl.units, dtl.price_per_unit, dtl.subtotal, dtl.disc_percent, dtl.disc_amount,
              dtl.disc_price_per_unit, dtl.net_of_tax, dtl.tax_code, dtl.tax_amount, dtl.gross_amount
       FROM delivery_ticket_lines dtl
       LEFT JOIN job_orders jo ON jo.id = dtl.job_order_id
       LEFT JOIN locations loc ON loc.id = dtl.location_id
       WHERE dtl.delivery_ticket_id = ? ORDER BY dtl.line_no`,
      [req.params.deliveryTicketId]
    );

    res.json({ ...dt, term: dt.term || dt.credit_term, lines });
  } catch (err) {
    next(err);
  }
});

router.get('/by-delivery-ticket/:deliveryTicketId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, invoice_no, date_created, gross_amount, status FROM sales_invoices WHERE delivery_ticket_id = ? ORDER BY id DESC',
      [req.params.deliveryTicketId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/by-sales-order/:salesOrderId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, invoice_no, date_created, gross_amount, status FROM sales_invoices WHERE sales_order_id = ? ORDER BY id DESC',
      [req.params.salesOrderId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[si]] = await pool.query(
      `SELECT si.*, so.sales_order_no, c.name AS customer_name, dt.dt_no,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name, d.name AS department_name,
              u.display_name AS created_by_name
       FROM sales_invoices si
       JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN delivery_tickets dt ON dt.id = si.delivery_ticket_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees sr ON sr.id = si.sales_rep_id
       LEFT JOIN locations loc ON loc.id = si.office_location_id
       LEFT JOIN departments d ON d.id = si.department_id
       LEFT JOIN users u ON u.id = si.created_by_user_id
       WHERE si.id = ?`,
      [req.params.id]
    );
    if (!si) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT sil.*, jo.job_order_no FROM sales_invoice_lines sil
       LEFT JOIN job_orders jo ON jo.id = sil.job_order_id
       WHERE sil.sales_invoice_id = ?`,
      [req.params.id]
    );

    const glImpact = await computeGlImpact(si, lines);
    res.json({ ...si, lines, gl_impact: glImpact });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'SalesInvoice' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Bill > SI from a Delivery Ticket: the ticket was the provisional, unbilled recognition
// (it posts to AR Trade - Unbilled) and this is the official invoice that supersedes it.
// The ticket flips to 'converted', which is both the audit trail and what stops it
// posting to the GL a second time -- see getPostedGlLines, which only posts open tickets.
//
// Lines are copied verbatim from the ticket rather than recomputed: the ticket's amounts
// were already reviewed and saved, and its ad-hoc "Add Item" charges have no Sales Order
// line to recompute from at all. Only SO-backed lines advance job_orders.quantity_invoiced
// -- an ad-hoc delivery fee isn't part of any job's ordered quantity.
async function billDeliveryTicket(req, res, conn) {
  const {
    delivery_ticket_id: deliveryTicketId, date_created: dateCreated, date_due: dateDue, term,
    bs_si_no: bsSiNo, po_no: poNo, sales_rep_id: salesRepId, office_location_id: officeLocationId,
    department_id: departmentId, bill_to_address: billToAddress, memo,
    withholding_tax_pct: withholdingTaxPct,
  } = req.body;

  const [[dt]] = await conn.query('SELECT id, sales_order_id, status FROM delivery_tickets WHERE id = ?', [deliveryTicketId]);
  if (!dt) return res.status(404).json({ error: 'Delivery Ticket not found.' });
  if (dt.status === 'void') return res.status(409).json({ error: 'This Delivery Ticket is void and cannot be billed.' });
  if (dt.status === 'converted') return res.status(409).json({ error: 'This Delivery Ticket has already been converted to an Invoice.' });

  const [lines] = await conn.query(
    'SELECT * FROM delivery_ticket_lines WHERE delivery_ticket_id = ? ORDER BY line_no', [deliveryTicketId]
  );
  if (!lines.length) return res.status(400).json({ error: 'This Delivery Ticket has no items to bill.' });

  const sum = (key) => Number(lines.reduce((s, l) => s + Number(l[key] || 0), 0).toFixed(2));
  const subtotal = sum('subtotal');
  const discountAmount = sum('disc_amount');
  const netOfTax = sum('net_of_tax');
  const taxAmount = sum('tax_amount');
  const grossAmount = sum('gross_amount');
  const ewtAmount = Number((netOfTax * (Number(withholdingTaxPct || 0) / 100)).toFixed(2));
  const amountDue = Number((grossAmount - ewtAmount).toFixed(2));

  await conn.beginTransaction();
  const [result] = await conn.query(
    `INSERT INTO sales_invoices
       (invoice_no, sales_order_id, delivery_ticket_id, date_created, date_due, term, bs_si_no, po_no,
        sales_rep_id, office_location_id, department_id, bill_to_address, memo, withholding_tax_pct,
        subtotal, discount_amount, net_of_tax, ewt_amount, tax_amount, gross_amount, amount_due, created_by_user_id)
     VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dt.sales_order_id, deliveryTicketId, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null,
      term || null, bsSiNo || null, poNo || null, salesRepId || null, officeLocationId || null, departmentId || null,
      billToAddress || null, memo || null, withholdingTaxPct || 0, subtotal, discountAmount, netOfTax,
      ewtAmount, taxAmount, grossAmount, amountDue, req.user.id,
    ]
  );
  const invoiceId = result.insertId;
  await conn.query('UPDATE sales_invoices SET invoice_no = ? WHERE id = ?', [`INV-${invoiceId}`, invoiceId]);

  for (const l of lines) {
    await conn.query(
      `INSERT INTO sales_invoice_lines
         (sales_invoice_id, sales_order_line_id, job_order_id, description, job_location_id, quantity, units,
          price_per_unit, subtotal, disc_percent, disc_amount, disc_price_per_unit, net_of_tax, tax_code,
          tax_amount, gross_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceId, l.sales_order_line_id, l.job_order_id, l.description, l.location_id, l.quantity, l.units,
        l.price_per_unit, l.subtotal, l.disc_percent, l.disc_amount, l.disc_price_per_unit, l.net_of_tax,
        l.tax_code, l.tax_amount, l.gross_amount,
      ]
    );
    if (l.job_order_id && l.sales_order_line_id) {
      await conn.query(
        'UPDATE job_orders SET quantity_invoiced = quantity_invoiced + ?, updated_at = NOW() WHERE id = ?',
        [l.quantity, l.job_order_id]
      );
    }
  }

  await conn.query(
    "UPDATE delivery_tickets SET status = 'converted' WHERE id = ?", [deliveryTicketId]
  );
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('DeliveryTicket', ?, 'Status Change', 'status', 'open', 'converted', ?)`,
    [deliveryTicketId, req.user.id]
  );

  const [freshLines] = await conn.query(
    `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, jo.quantity_invoiced
     FROM sales_order_lines sol
     LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`,
    [dt.sales_order_id]
  );
  const newSoStatus = computeSalesOrderStatus(freshLines);
  await conn.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [newSoStatus, dt.sales_order_id]);
  await logAudit(conn, { invoiceId, userId: req.user.id, eventType: 'Created', fieldName: 'invoice_no', newValue: `INV-${invoiceId}` });
  await conn.commit();

  const [[row]] = await pool.query('SELECT * FROM sales_invoices WHERE id = ?', [invoiceId]);
  return res.status(201).json(row);
}

// Saving is what actually marks each included SO line as billed -- every line's own
// quantity_delivered - quantity_invoiced gap gets caught up in one shot (the real form
// has no per-line "amount to invoice" input, just Delete to exclude a line entirely).
router.post('/', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      sales_order_id: salesOrderId, date_created: dateCreated, date_due: dateDue, term, bs_si_no: bsSiNo,
      po_no: poNo, sales_rep_id: salesRepId, office_location_id: officeLocationId, department_id: departmentId,
      bill_to_address: billToAddress, memo, withholding_tax_pct: withholdingTaxPct, sales_order_line_ids: lineIds,
    } = req.body;
    if (!salesOrderId) return res.status(400).json({ error: 'Sales Order is required.' });

    // Billing a Delivery Ticket is a different path entirely: the ticket's own lines are
    // what get invoiced (its ad-hoc charges included), not the Sales Order's
    // delivered-but-unbilled gap. Handled in its own function to keep the two flows from
    // growing into each other.
    if (req.body.delivery_ticket_id) {
      return billDeliveryTicket(req, res, conn);
    }

    const submittedIds = (Array.isArray(lineIds) ? lineIds : []).map(Number);
    if (!submittedIds.length) return res.status(400).json({ error: 'Include at least one item.' });

    const [rawLines] = await conn.query(
      `SELECT sol.*, jo.id AS job_order_id, jo.quantity_delivered, jo.quantity_invoiced, t.rate AS tax_rate
       FROM sales_order_lines sol JOIN job_orders jo ON jo.id = sol.job_order_id
       LEFT JOIN taxes t ON t.id = sol.tax_code_id
       WHERE sol.sales_order_id = ? AND sol.id IN (?)`,
      [salesOrderId, submittedIds]
    );
    if (rawLines.length !== submittedIds.length) return res.status(400).json({ error: 'One of the selected items is no longer eligible.' });
    for (const l of rawLines) {
      if (Number(l.quantity_delivered) <= Number(l.quantity_invoiced)) {
        return res.status(409).json({ error: `Line ${l.line_no} has nothing left to invoice.` });
      }
    }

    // The delta caught up in *this* transaction -- not the line's full ordered qty -- is
    // what gets billed (a JO can be delivered short of its ordered qty while still fully
    // caught up on invoicing so far, e.g. Built=QI=Delivered=1 of an ordered qty=2), same
    // running-total discipline as Item Fulfillment/Receipt/Delivery. price_per_unit/
    // disc_percent/tax rate are fixed per-unit rates, so Subtotal/Disc/Net/Tax/Gross are
    // recomputed against that billable qty rather than copied from the line's full-Qty totals.
    const lines = rawLines.map((l) => {
      const invoicedNow = Number(l.quantity_delivered) - Number(l.quantity_invoiced);
      return {
        ...l,
        invoicedNow,
        ...computeBillableLineAmounts({
          pricePerUnit: l.price_per_unit, discPercent: l.disc_percent, taxRate: l.tax_rate, billableQty: invoicedNow,
        }),
      };
    });

    const subtotal = lines.reduce((s, l) => s + Number(l.subtotal || 0), 0);
    const discountAmount = lines.reduce((s, l) => s + Number(l.disc_amount || 0), 0);
    const netOfTax = lines.reduce((s, l) => s + Number(l.net_of_tax || 0), 0);
    const taxAmount = lines.reduce((s, l) => s + Number(l.tax_amount || 0), 0);
    const grossAmount = lines.reduce((s, l) => s + Number(l.gross_amount || 0), 0);
    const ewtAmount = netOfTax * (Number(withholdingTaxPct || 0) / 100);
    const amountDue = grossAmount - ewtAmount;

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO sales_invoices
         (invoice_no, sales_order_id, date_created, date_due, term, bs_si_no, po_no, sales_rep_id, office_location_id,
          department_id, bill_to_address, memo, withholding_tax_pct, subtotal, discount_amount, net_of_tax,
          ewt_amount, tax_amount, gross_amount, amount_due, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        salesOrderId, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null, term || null,
        bsSiNo || null, poNo || null, salesRepId || null, officeLocationId || null, departmentId || null,
        billToAddress || null, memo || null, withholdingTaxPct || 0, subtotal, discountAmount, netOfTax,
        ewtAmount, taxAmount, grossAmount, amountDue, req.user.id,
      ]
    );
    const invoiceId = result.insertId;
    // The record itself is always an "Invoice" (INV-#), regardless of which Bill
    // dropdown option created it -- SI/BS/DR/DT is only ever its Type, not its number.
    await conn.query('UPDATE sales_invoices SET invoice_no = ? WHERE id = ?', [`INV-${invoiceId}`, invoiceId]);

    for (const l of lines) {
      await conn.query(
        `INSERT INTO sales_invoice_lines
           (sales_invoice_id, sales_order_line_id, job_order_id, description, job_location_id, quantity, units,
            price_per_unit, subtotal, disc_percent, disc_amount, disc_price_per_unit, net_of_tax, tax_code,
            tax_amount, gross_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT code FROM taxes WHERE id = ?), ?, ?)`,
        [
          invoiceId, l.id, l.job_order_id, l.description, l.job_location_id, l.invoicedNow, l.units,
          l.price_per_unit, l.subtotal, l.disc_percent, l.disc_amount, l.disc_price_per_unit, l.net_of_tax,
          l.tax_code_id, l.tax_amount, l.gross_amount,
        ]
      );
      await conn.query(
        'UPDATE job_orders SET quantity_invoiced = quantity_invoiced + ?, updated_at = NOW() WHERE id = ?',
        [l.invoicedNow, l.job_order_id]
      );
    }

    // A Sales Order's status is only ever as advanced as its *least* advanced line --
    // see computeSalesOrderStatus for the full hierarchy (an unstarted line elsewhere
    // pulls the whole order back to "In Process" even after this one's fully billed).
    const [freshLines] = await conn.query(
      `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, jo.quantity_invoiced
       FROM sales_order_lines sol
       LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`,
      [salesOrderId]
    );
    const newSoStatus = computeSalesOrderStatus(freshLines);
    await conn.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [newSoStatus, salesOrderId]);
    await logAudit(conn, { invoiceId, userId: req.user.id, eventType: 'Created', fieldName: 'invoice_no', newValue: `INV-${invoiceId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM sales_invoices WHERE id = ?', [invoiceId]);
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
    const [[si]] = await conn.query('SELECT status, sales_order_id, delivery_ticket_id FROM sales_invoices WHERE id = ?', [req.params.id]);
    if (!si) return res.status(404).json({ error: 'Not found' });
    if (si.status === 'cancelled') return res.status(409).json({ error: 'This Sales Invoice is already cancelled.' });

    const [lines] = await conn.query('SELECT job_order_id, sales_order_line_id, quantity FROM sales_invoice_lines WHERE sales_invoice_id = ?', [req.params.id]);

    await conn.beginTransaction();
    for (const l of lines) {
      if (l.job_order_id) {
        await conn.query('UPDATE job_orders SET quantity_invoiced = GREATEST(quantity_invoiced - ?, 0) WHERE id = ?', [l.quantity, l.job_order_id]);
      }
    }
    // Voiding an invoice raised off a Delivery Ticket releases that ticket back to open,
    // so it can be billed again rather than being stranded as 'converted' against an
    // invoice that no longer exists. Its GL posting resumes with it.
    if (si.delivery_ticket_id) {
      await conn.query("UPDATE delivery_tickets SET status = 'open' WHERE id = ? AND status = 'converted'", [si.delivery_ticket_id]);
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('DeliveryTicket', ?, 'Status Change', 'status', 'converted', 'open', ?)`,
        [si.delivery_ticket_id, req.user.id]
      );
    }
    await conn.query(
      "UPDATE sales_invoices SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    const [[so]] = await conn.query('SELECT status FROM sales_orders WHERE id = ?', [si.sales_order_id]);
    if (so && so.status !== 'cancelled') {
      const [freshLines] = await conn.query(
        `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, jo.quantity_invoiced
         FROM sales_order_lines sol
         LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`,
        [si.sales_order_id]
      );
      const newSoStatus = computeSalesOrderStatus(freshLines);
      if (newSoStatus !== so.status) {
        await conn.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [newSoStatus, si.sales_order_id]);
      }
    }
    await logAudit(conn, { invoiceId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'saved', newValue: 'cancelled' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM sales_invoices WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
