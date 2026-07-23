const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeDeliveryTicketGl } = require('../lib/glImpact');

const router = express.Router();
// Like Sales Invoices (and unlike Item Fulfillment/Receipt, which borrow their parent's
// scope), a Delivery Ticket has its own detail screen reached by its own URL, so it gets
// a real page entry rather than a borrowed one. Registered by
// src/db/create-delivery-tickets.js, which also grants admins full access.
const ROUTE = '/delivery-tickets';

async function logAudit(conn, { ticketId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('DeliveryTicket', ?, ?, ?, ?, ?, ?)`,
    [ticketId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Every figure on a line derives from four inputs the create form lets you edit per row
// (qty, price/unit, disc %, tax rate). Recomputed server-side from those rather than
// trusting the client's arithmetic -- the browser's numbers are a preview, this is the
// record. Disc./Unit and Disc. Price/Unit are the two per-unit columns the real DT view
// shows alongside the absolute discount amount.
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

// Powers the Create DT form. Same eligibility as Create SI -- SO lines whose JO has been
// delivered but not yet fully invoiced -- so the DT button opens onto the same rows the
// Bill dropdown already gates on, each prefilled with its still-unbilled qty.
router.get('/for-sales-order/:salesOrderId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[so]] = await pool.query(
      `SELECT so.id, so.sales_order_no, so.credit_term, so.sales_rep_id, so.office_location_id,
              so.contact_email, so.contact_title, so.contact_phone,
              c.name AS customer_name, c.tin AS customer_tin,
              cc.contact_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name
       FROM sales_orders so
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN locations loc ON loc.id = so.office_location_id
       WHERE so.id = ?`,
      [req.params.salesOrderId]
    );
    if (!so) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT sol.id AS sales_order_line_id, sol.job_order_id, jo.job_order_no,
              jt.display_name AS item_name, sol.description,
              sol.job_location_id AS location_id, loc.location_name,
              sol.units, sol.uom AS unit_title, sol.price_per_unit, sol.disc_percent,
              sol.tax_code_id, t.code AS tax_code, t.rate AS tax_rate,
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

    const prefilled = lines.map((l) => {
      const quantity = Number(l.quantity_delivered) - Number(l.quantity_invoiced);
      return {
        ...l,
        quantity,
        ...computeLineAmounts({
          quantity, pricePerUnit: l.price_per_unit, discPercent: l.disc_percent, taxRate: l.tax_rate,
        }),
      };
    });

    res.json({ ...so, lines: prefilled });
  } catch (err) {
    next(err);
  }
});

// Flat list with a Status filter, same shape as Saved Invoices -- no status tabs, since
// a ticket only ever sits in one of three states.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('dt.status = ?'); params.push(status); }
    if (search) {
      where.push('(dt.dt_no LIKE ? OR so.sales_order_no LIKE ? OR c.name LIKE ? OR dt.po_no LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT dt.id, dt.dt_no, dt.date_created, dt.date_due, dt.term, dt.po_no, dt.memo, dt.status,
              dt.net_of_tax, dt.tax_amount, dt.gross_amount, dt.amount_due,
              so.sales_order_no, c.name AS customer_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name, d.name AS department_name,
              si.id AS sales_invoice_id, si.invoice_no
       FROM delivery_tickets dt
       JOIN sales_orders so ON so.id = dt.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees sr ON sr.id = dt.sales_rep_id
       LEFT JOIN locations loc ON loc.id = dt.office_location_id
       LEFT JOIN departments d ON d.id = dt.department_id
       LEFT JOIN sales_invoices si ON si.delivery_ticket_id = dt.id AND si.status != 'cancelled'
       ${whereSql}
       ORDER BY dt.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/by-sales-order/:salesOrderId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, dt_no, date_created, gross_amount, status FROM delivery_tickets WHERE sales_order_id = ? ORDER BY id DESC',
      [req.params.salesOrderId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[dt]] = await pool.query(
      `SELECT dt.*, so.sales_order_no, so.contact_email, so.contact_title, so.contact_phone,
              c.name AS customer_name, c.tin AS customer_tin, cc.contact_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name, d.name AS department_name,
              u.display_name AS created_by_name
       FROM delivery_tickets dt
       JOIN sales_orders so ON so.id = dt.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN employees sr ON sr.id = dt.sales_rep_id
       LEFT JOIN locations loc ON loc.id = dt.office_location_id
       LEFT JOIN departments d ON d.id = dt.department_id
       LEFT JOIN users u ON u.id = dt.created_by_user_id
       WHERE dt.id = ?`,
      [req.params.id]
    );
    if (!dt) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT dtl.*, jo.job_order_no, loc.location_name
       FROM delivery_ticket_lines dtl
       LEFT JOIN job_orders jo ON jo.id = dtl.job_order_id
       LEFT JOIN locations loc ON loc.id = dtl.location_id
       WHERE dtl.delivery_ticket_id = ? ORDER BY dtl.line_no`,
      [req.params.id]
    );

    const glImpact = await computeDeliveryTicketGl(dt, lines);
    res.json({ ...dt, lines, gl_impact: glImpact });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'DeliveryTicket' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Saving a DT deliberately does NOT advance job_orders.quantity_invoiced the way saving a
// Sales Invoice does. The ticket posts to AR Trade - *Unbilled*: the goods have gone and
// the sale is recognised, but nothing has been billed yet, so the SO's lines must stay
// eligible for the invoice that follows. See the DT's own Bill button in the real system,
// which is what actually bills it (not modelled here yet).
router.post('/', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      sales_order_id: salesOrderId, date_created: dateCreated, date_due: dateDue, term, po_no: poNo,
      sales_rep_id: salesRepId, office_location_id: officeLocationId, department_id: departmentId,
      memo, lines,
    } = req.body;
    if (!salesOrderId) return res.status(400).json({ error: 'Sales Order is required.' });

    const [[so]] = await conn.query('SELECT id FROM sales_orders WHERE id = ?', [salesOrderId]);
    if (!so) return res.status(404).json({ error: 'Sales Order not found.' });

    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => Number(l.quantity) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Include at least one item.' });

    // A line either comes from an SO line or was added ad-hoc via "Add Item". SO-backed
    // lines have their identifying fields taken from the order rather than the request,
    // so a tampered payload can't re-point a line at another order's JO. Ad-hoc lines
    // carry only what the form collected.
    const soLineIds = submitted.map((l) => Number(l.sales_order_line_id)).filter(Boolean);
    const soLineById = new Map();
    if (soLineIds.length) {
      const [rows] = await conn.query(
        `SELECT sol.id, sol.job_order_id, sol.description, sol.job_location_id, sol.units, sol.uom,
                sol.tax_code_id, jt.display_name AS item_name, t.code AS tax_code, t.rate AS tax_rate
         FROM sales_order_lines sol
         LEFT JOIN job_types jt ON jt.id = sol.job_type_id
         LEFT JOIN taxes t ON t.id = sol.tax_code_id
         WHERE sol.sales_order_id = ? AND sol.id IN (?)`,
        [salesOrderId, soLineIds]
      );
      rows.forEach((r) => soLineById.set(r.id, r));
      if (rows.length !== new Set(soLineIds).size) {
        return res.status(400).json({ error: 'One of the selected items no longer belongs to this Sales Order.' });
      }
    }

    // An ad-hoc line names its own tax code; resolve its rate the same way rather than
    // assuming the order's.
    const adhocTaxCodes = [...new Set(submitted.filter((l) => !l.sales_order_line_id && l.tax_code).map((l) => l.tax_code))];
    const taxByCode = new Map();
    if (adhocTaxCodes.length) {
      const [rows] = await conn.query('SELECT code, rate FROM taxes WHERE code IN (?)', [adhocTaxCodes]);
      rows.forEach((r) => taxByCode.set(r.code, r));
    }

    const prepared = submitted.map((l, idx) => {
      const src = l.sales_order_line_id ? soLineById.get(Number(l.sales_order_line_id)) : null;
      const taxCode = src ? src.tax_code : (l.tax_code || null);
      const taxRate = src ? src.tax_rate : (taxByCode.get(l.tax_code)?.rate || 0);
      const pricePerUnit = Number(l.price_per_unit || 0);
      const discPercent = Number(l.disc_percent || 0);
      const quantity = Number(l.quantity);
      return {
        line_no: idx + 1,
        sales_order_line_id: src ? src.id : null,
        job_order_id: src ? src.job_order_id : null,
        item_id: l.item_id || null,
        item_name: src ? src.item_name : (l.item_name || null),
        // Description stays editable even on an SO-backed line -- the real form lets you
        // retype it (that is how "DELIVERY FEE" ends up on a MOBILIZATION line).
        description: l.description ?? (src ? src.description : null),
        location_id: l.location_id || (src ? src.job_location_id : null),
        quantity,
        units: l.units ?? (src ? src.units : null),
        unit_title: l.unit_title ?? (src ? src.uom : null),
        price_per_unit: pricePerUnit,
        disc_percent: discPercent,
        tax_code: taxCode,
        ...computeLineAmounts({ quantity, pricePerUnit, discPercent, taxRate }),
      };
    });

    const sum = (key) => Number(prepared.reduce((s, l) => s + Number(l[key] || 0), 0).toFixed(2));
    const subtotal = sum('subtotal');
    const discountAmount = sum('disc_amount');
    const netOfTax = sum('net_of_tax');
    const taxAmount = sum('tax_amount');
    const grossAmount = sum('gross_amount');

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO delivery_tickets
         (dt_no, sales_order_id, date_created, date_due, term, po_no, sales_rep_id, office_location_id,
          department_id, memo, subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, amount_due,
          created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        salesOrderId, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null, term || null,
        poNo || null, salesRepId || null, officeLocationId || null, departmentId || null, memo || null,
        subtotal, discountAmount, netOfTax, taxAmount, grossAmount, grossAmount, req.user.id,
      ]
    );
    const ticketId = result.insertId;
    // Its own DT-# sequence -- a Delivery Ticket is not an Invoice and never borrows the
    // INV-# series (confirmed against the real system's DT-1316).
    await conn.query('UPDATE delivery_tickets SET dt_no = ? WHERE id = ?', [`DT-${ticketId}`, ticketId]);

    for (const l of prepared) {
      await conn.query(
        `INSERT INTO delivery_ticket_lines
           (delivery_ticket_id, line_no, sales_order_line_id, job_order_id, item_id, item_name, description,
            location_id, quantity, units, unit_title, price_per_unit, subtotal, disc_percent, disc_per_unit,
            disc_amount, disc_price_per_unit, net_of_tax, tax_code, tax_amount, gross_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ticketId, l.line_no, l.sales_order_line_id, l.job_order_id, l.item_id, l.item_name, l.description,
          l.location_id, l.quantity, l.units, l.unit_title, l.price_per_unit, l.subtotal, l.disc_percent,
          l.disc_per_unit, l.disc_amount, l.disc_price_per_unit, l.net_of_tax, l.tax_code, l.tax_amount,
          l.gross_amount,
        ]
      );
    }

    await logAudit(conn, { ticketId, userId: req.user.id, eventType: 'Created', fieldName: 'dt_no', newValue: `DT-${ticketId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM delivery_tickets WHERE id = ?', [ticketId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Void, not delete -- the real screen's own terminal action. Nothing to reverse on the
// Sales Order because saving never advanced quantity_invoiced in the first place; voiding
// simply stops the ticket posting to the GL (see getPostedGlLines' status filter).
router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[dt]] = await conn.query('SELECT status FROM delivery_tickets WHERE id = ?', [req.params.id]);
    if (!dt) return res.status(404).json({ error: 'Not found' });
    if (dt.status === 'void') return res.status(409).json({ error: 'This Delivery Ticket is already void.' });

    await conn.beginTransaction();
    await conn.query(
      "UPDATE delivery_tickets SET status = 'void', voided_by_user_id = ?, voided_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    // 'Cancelled', not 'Voided' -- audit_logs.event_type is a fixed enum and this is the
    // value Sales Invoice's own void already writes. The screen calls it Void; the audit
    // vocabulary is shared across every module and isn't worth widening for a synonym.
    await logAudit(conn, {
      ticketId: req.params.id, userId: req.user.id, eventType: 'Cancelled',
      fieldName: 'status', oldValue: dt.status, newValue: 'void',
    });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM delivery_tickets WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
