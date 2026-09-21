const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { computeSalesOrderStatus } = require('../lib/salesOrderStatus');
const { computeSalesInvoiceGl } = require('../lib/glImpact');

const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');
const { whyNotBillable } = require('../lib/estimateBilling');
const { isHeadOfficeUser } = require('../lib/userLocation');
const { postReversalJournal } = require('../lib/reversalJournal');

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
    const {
      search, status, customer_id: customerId, sales_rep_id: salesRepId,
      from, to, department_id: departmentId,
      page = '1', limit = '10',
    } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('si.status = ?'); params.push(status); }
    // An invoice raised from an Estimate has no Sales Order, so the customer is whichever of the
    // two sources it actually has. Same COALESCE everywhere the customer is read below.
    if (customerId) { where.push('COALESCE(so.customer_id, e.customer_id) = ?'); params.push(customerId); }
    if (salesRepId) { where.push('si.sales_rep_id = ?'); params.push(salesRepId); }
    // Date Created, inclusive at both ends, and either end usable on its own -- "everything since
    // March" is as ordinary a question as a closed month. Compared as plain dates because the
    // column is a DATE: no time component to push a row past midnight and out of its own range.
    // idx_sales_invoices_date_created already covers this.
    if (from) { where.push('si.date_created >= ?'); params.push(from); }
    if (to) { where.push('si.date_created <= ?'); params.push(to); }
    // The invoice's OWN department (si.department_id), not the Sales Order's. They are usually the
    // same, but the invoice carries its own because billing can be charged elsewhere -- and it is
    // si.department_id the list column already displays, so filtering on anything else would
    // return rows whose Department cell disagreed with the filter that found them.
    //
    // 19,089 of 74,280 invoices carry no department at all. Those match no department filter, which
    // is correct -- they are unassigned, not assigned to everyone -- and they are all still there
    // under --ALL--.
    if (departmentId) { where.push('si.department_id = ?'); params.push(departmentId); }
    // An Account Officer sees only their own invoices; a Supervisor sees theirs plus their
    // reports'. Same rule Estimates and Sales Orders already apply -- see lib/salesVisibility.js,
    // which returns null (and so changes nothing) for every account that is neither.
    const salesScope = await getSalesRepEmployeeScope(req.user.id);
    if (salesScope) { where.push('si.sales_rep_id IN (?)'); params.push(salesScope); }
    if (search) {
      where.push('(si.invoice_no LIKE ? OR so.sales_order_no LIKE ? OR e.estimate_no LIKE ? OR c.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // PAGINATED SERVER-SIDE. This used to return every invoice with no LIMIT -- 73,202 rows and
    // 30.6 MB measured on production -- while the page showed ten and sliced the rest away in
    // the browser. About 2 s of that was the server and ~9 s the transfer, before the browser
    // then parsed 30 MB of JSON to render 10 rows. Same shape as the Sales Orders list.
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    // The count carries only the joins its own filters reference. sales_orders and estimates are
    // both LEFT joins now and neither decides membership -- an invoice has exactly one of the two,
    // and an INNER join on sales_orders would have hidden every estimate-sourced invoice from the
    // list entirely. customers comes in for the search and the customer filter; employees,
    // locations and departments are LEFT joins nothing filters on.
    const needsSource = Boolean(search || customerId);
    const countFrom = `FROM sales_invoices si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       ${needsSource ? 'LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, e.customer_id)' : ''}`;
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${countFrom} ${whereSql}`, params
    );

    const [rows] = await pool.query(
      `SELECT si.id, si.invoice_no, si.date_created, si.date_due, si.net_of_tax, si.tax_amount,
              si.gross_amount, si.amount_due, si.bs_si_no, si.term, si.status, si.memo,
              so.sales_order_no, e.estimate_no, c.name AS customer_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name, d.name AS department_name
       FROM sales_invoices si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, e.customer_id)
       LEFT JOIN employees sr ON sr.id = si.sales_rep_id
       LEFT JOIN locations loc ON loc.id = si.office_location_id
       LEFT JOIN departments d ON d.id = si.department_id
       ${whereSql}
       ORDER BY si.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );
    res.json({ rows, total, page: pageNum, limit: limitNum });
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

// Powers Create SI when it was raised straight from the invoice list against an Estimate, with no
// Sales Order behind it at all.
//
// Nothing is netted off here, unlike the Sales Order path: there are no Job Orders yet, so there
// is no delivered-minus-invoiced gap to bill. The Estimate's own lines ARE the invoice, and their
// stored money columns are used as they stand -- they were priced and approved on the Estimate,
// and recomputing them would quietly restate an approved figure.
//
// The JO # column is empty only while there is genuinely no Job Order. Once an Estimate has been
// converted, its lines DO have one -- sales_order_lines.estimate_job_order_id points straight back
// here -- and 3,515 of the 4,721 estimate lines resolve to one. Showing a dash for those was
// wrong: it read as "this work has no Job Order" when the truth was "this form never looked".
router.get('/for-estimate/:estimateId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[est]] = await pool.query(
      `SELECT e.id AS estimate_id, e.estimate_no, e.credit_term, e.sales_rep_id, e.office_location_id,
              e.shipping_address, e.memo, e.sales_order_id, e.status,
              c.name AS customer_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name,
              so.sales_order_no
       FROM estimates e
       LEFT JOIN customers c ON c.id = e.customer_id
       LEFT JOIN employees sr ON sr.id = e.sales_rep_id
       LEFT JOIN locations loc ON loc.id = e.office_location_id
       LEFT JOIN sales_orders so ON so.id = e.sales_order_id
       WHERE e.id = ?`,
      [req.params.estimateId]
    );
    if (!est) return res.status(404).json({ error: 'Not found' });

    // Same visibility rule the estimate list applies -- an Account Officer cannot invoice an
    // estimate they are not allowed to see.
    const salesScope = await getSalesRepEmployeeScope(req.user.id);
    if (salesScope && !salesScope.includes(est.sales_rep_id)) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Only a supervisor-approved estimate may be billed. Refused here as well as on save, so an
    // ineligible estimate reached by any route than the picker says why instead of quietly
    // opening a form that cannot be saved.
    const blocked = whyNotBillable(est);
    if (blocked) return res.status(409).json({ error: blocked });

    const [lines] = await pool.query(
      `SELECT ejo.id AS estimate_job_order_id, ejo.job_type_id, jt.display_name AS item_name,
              ejo.description, ejo.job_location_id, loc.location_name AS job_location_name,
              ejo.quantity, ejo.units, ejo.price_per_unit, ejo.disc_percent, ejo.disc_price_per_unit,
              ejo.subtotal, ejo.disc_amount, ejo.net_of_tax, ejo.tax_amount, ejo.gross_amount,
              t.code AS tax_code, ejo.nstdjo_no,
              jo.id AS job_order_id, jo.job_order_no,
              jo.quantity_delivered, jo.quantity_invoiced
       FROM estimate_job_orders ejo
       LEFT JOIN job_types jt ON jt.id = ejo.job_type_id
       LEFT JOIN locations loc ON loc.id = ejo.job_location_id
       LEFT JOIN taxes t ON t.id = ejo.tax_code_id
       LEFT JOIN sales_order_lines sol ON sol.estimate_job_order_id = ejo.id
       LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
       WHERE ejo.estimate_id = ?
       ORDER BY ejo.line_no`,
      [req.params.estimateId]
    );

    // Already invoiced off this Estimate. Not a block -- part-billing an estimate across several
    // invoices is legitimate -- but the form says so, because nothing else would.
    const [[prior]] = await pool.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(gross_amount), 0) AS billed
         FROM sales_invoices WHERE estimate_id = ? AND status <> 'cancelled'`,
      [req.params.estimateId]
    );

    res.json({
      ...est,
      lines,
      prior_invoice_count: Number(prior.n),
      prior_invoiced_amount: Number(prior.billed),
    });
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

// The Sales Order's Related Records tab.
//
// A Sales-Order-path or Delivery-Ticket-path invoice lists as soon as it exists: it was raised
// against this order's own delivered-minus-invoiced quantities, so the order is where it came from.
//
// AN ESTIMATE-SOURCED INVOICE WAITS FOR THE WORK. It can be raised long before anything is made --
// an estimate is billable from pending_customer_approval, which is before the order and its job
// orders even exist -- so listing it the moment it is linked would put an invoice on the order for
// work the floor has not finished. It appears once every job order behind it is done.
//
// Done means production_stage IN ('completed','invoiced'), the same pair routes/production.js uses
// to mean "no longer open", not status = 'Completed': production_stage is the ladder the floor
// actually climbs, and 'invoiced' sits PAST 'completed' on it, so testing for completed alone would
// drop a job order again the moment it moved on.
//
// The job order is resolved two ways because the invoice line records it only when it existed at
// billing time: sil.job_order_id when the estimate was already converted, otherwise through the
// order line that shares the estimate line (sol.estimate_job_order_id). A line that resolves to no
// job order at all is not completed either, so it holds the invoice back -- deliberately, since
// that is a line nothing on this order is building.
//
// Gating the LIST rather than the link: sales_invoices.sales_order_id stays written, because the
// invoice does belong to the order -- AR, the invoice's own view and every report read it. What
// waits is only what this tab shows. That also makes it self-correcting: completing the job order
// is enough to surface the invoice, with nothing to re-run and nothing to backfill.
// The filter bar's Department options.
//
// Served from here, under THIS page's own can_view, rather than from /lookups/departments the way
// most pickers in this build are. 8 of the 40 users who can view invoices hold no permission on
// /lookups at all: for them that call answers 403 and the dropdown would sit silently empty on a
// page they are fully entitled to filter. Borrowing another page's scope to populate a control is
// how that happens -- see src/db/add-can-update-permission.js's sibling problem.
//
// Every department is offered, not just the ones already on an invoice: a DISTINCT over 74,280
// rows on an unindexed column costs more than the 29-row table, and a department with no invoices
// yet is a legitimate thing to ask about and get an empty list for.
router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [departments] = await pool.query('SELECT id, name FROM departments ORDER BY name');
    res.json({ departments });
  } catch (err) {
    next(err);
  }
});

router.get('/by-sales-order/:salesOrderId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT si.id, si.invoice_no, si.date_created, si.gross_amount, si.status
         FROM sales_invoices si
        WHERE si.sales_order_id = ?
          AND (si.estimate_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM sales_invoice_lines sil
                  LEFT JOIN sales_order_lines sol
                         ON sol.estimate_job_order_id = sil.estimate_job_order_id
                        AND sol.sales_order_id = si.sales_order_id
                  LEFT JOIN job_orders jo ON jo.id = COALESCE(sil.job_order_id, sol.job_order_id)
                 WHERE sil.sales_invoice_id = si.id
                   AND (jo.production_stage IS NULL OR jo.production_stage NOT IN ('completed', 'invoiced'))
              ))
        ORDER BY si.id DESC`,
      [req.params.salesOrderId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    // customer_tin / customer_address feed the pre-printed Billing Statement form, whose
    // header blanks sit above the line items. The address falls back to any address on file
    // when no BILLING one is flagged default, since most customers carry only one.
    const [[si]] = await pool.query(
      `SELECT si.*, so.sales_order_no, e.estimate_no, c.name AS customer_name, dt.dt_no,
              c.tin AS customer_tin, c.company_name AS customer_company,
              COALESCE(
                (SELECT ca.address_line FROM customer_addresses ca
                  WHERE ca.customer_id = c.id AND ca.address_type = 'BILLING' AND ca.is_default = TRUE LIMIT 1),
                (SELECT ca.address_line FROM customer_addresses ca
                  WHERE ca.customer_id = c.id ORDER BY ca.is_default DESC, ca.id LIMIT 1)
              ) AS customer_address,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name, d.name AS department_name,
              u.display_name AS created_by_name
       FROM sales_invoices si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN delivery_tickets dt ON dt.id = si.delivery_ticket_id
       LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, e.customer_id)
       LEFT JOIN employees sr ON sr.id = si.sales_rep_id
       LEFT JOIN locations loc ON loc.id = si.office_location_id
       LEFT JOIN departments d ON d.id = si.department_id
       LEFT JOIN users u ON u.id = si.created_by_user_id
       WHERE si.id = ?`,
      [req.params.id]
    );
    if (!si) return res.status(404).json({ error: 'Not found' });
    // Defence in depth for the list filter above: hiding a document from the list while still
    // serving it to anyone who types its id is not a restriction. See lib/salesVisibility.js.
    const salesScope = await getSalesRepEmployeeScope(req.user.id);
    if (salesScope && !salesScope.includes(si.sales_rep_id)) {
      return res.status(404).json({ error: 'Not found' });
    }

    // item_code comes from the line's job type -- this ERP's product code, which the Type 2
    // invoice print has an Item Code column for. It is resolved through the job order first
    // and the sales-order line only as a fallback: sales_order_line_id is set on just 4 of
    // ~118,000 invoice lines, while job_order_id is set on ~88% of them.
    //
    // An estimate-sourced line has neither, which is why it carries its own job_type_id -- it is
    // the last resort here rather than the first, so nothing changes for the lines that already
    // resolve. job_order_no stays null on those lines and the JO # column reads empty, which is
    // the truth: no Job Order exists until the Estimate is converted.
    const [lines] = await pool.query(
      `SELECT sil.*, jo.job_order_no, jt.item_code, jt.display_name AS item_name
       FROM sales_invoice_lines sil
       LEFT JOIN job_orders jo ON jo.id = sil.job_order_id
       LEFT JOIN sales_order_lines sol ON sol.id = sil.sales_order_line_id
       LEFT JOIN job_types jt ON jt.id = COALESCE(jo.job_type_id, sol.job_type_id, sil.job_type_id)
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
  await assertPeriodOpen(dateCreated, 'ar', conn);

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
// Bills an Estimate directly. Reached from Create New on the invoice list, for work that is
// invoiced before it is ever converted into a Sales Order.
//
// What this deliberately does NOT do, against the Sales Order path:
//   - no delivered-minus-invoiced arithmetic: there are no Job Orders to have delivered anything
//   - no job_orders.quantity_invoiced update, for the same reason
//   - no Sales Order status recompute
// The Estimate's own line figures are written through as they stand, because they were priced and
// approved there. The invoice is still an INV-#, as every invoice in this build is.
//
// BUT IT DOES RECORD THE SALES ORDER, when the estimate has one. "Invoiced before it is ever
// converted" is the case this path was built for, not the only case it serves: an estimate is
// billable from pending_customer_approval AND from approved, and reaching approved is exactly
// what generates the Sales Order. So the common path here is an estimate that HAS an order, and
// writing sales_order_id NULL left those invoices off that order's Related Records entirely --
// invisible from the order they belong to. Two live invoices were in that state.
//
// Recording the link is all this does. The quantity accounting above stays untouched, so the
// order's own billed/delivered figures do not move; the invoice becomes findable from the order
// rather than counted by it. Findable, not yet listed: the order's Related Records tab holds an
// estimate-sourced invoice back until the job orders behind it are finished -- see the
// by-sales-order route above for that gate and why it lives there rather than here.
async function billEstimate(req, res, conn) {
  const {
    estimate_id: estimateId, date_created: dateCreated, date_due: dateDue, term, bs_si_no: bsSiNo,
    po_no: poNo, sales_rep_id: salesRepId, office_location_id: officeLocationId, department_id: departmentId,
    bill_to_address: billToAddress, memo, withholding_tax_pct: withholdingTaxPct,
    estimate_job_order_ids: submitted,
  } = req.body;

  const [[est]] = await conn.query(
    'SELECT id, estimate_no, sales_rep_id, status, sales_order_id FROM estimates WHERE id = ?', [estimateId]);
  if (!est) return res.status(404).json({ error: 'That Estimate no longer exists.' });

  // The same visibility rule as everywhere else: an Account Officer cannot bill an estimate they
  // are not allowed to see. Checked on the server because the picker being filtered is not a
  // restriction.
  const salesScope = await getSalesRepEmployeeScope(req.user.id);
  if (salesScope && !salesScope.includes(est.sales_rep_id)) {
    return res.status(404).json({ error: 'That Estimate no longer exists.' });
  }

  // THE decision point. A filtered picker and a refusing form are both conveniences; this is the
  // one an estimate cannot be billed around, including by a request that never went near the UI.
  // Re-read inside the request rather than trusted from when the form was opened -- an estimate
  // can be cancelled between opening Create SI and pressing Save.
  const blocked = whyNotBillable(est);
  if (blocked) return res.status(409).json({ error: blocked });

  const submittedIds = (Array.isArray(submitted) ? submitted : []).map(Number).filter(Boolean);
  if (!submittedIds.length) return res.status(400).json({ error: 'Include at least one item.' });

  // job_order_id comes along when the Estimate has been converted, so the saved invoice shows the
  // same JO # the form did. It is recorded, NOT billed: quantity_invoiced is left alone, because
  // that running total belongs to the Sales Order path and tracks delivered-versus-invoiced. An
  // estimate-sourced invoice has not delivered anything.
  const [lines] = await conn.query(
    `SELECT ejo.*, t.code AS tax_code, sol.job_order_id
       FROM estimate_job_orders ejo
       LEFT JOIN taxes t ON t.id = ejo.tax_code_id
       LEFT JOIN sales_order_lines sol ON sol.estimate_job_order_id = ejo.id
      WHERE ejo.estimate_id = ? AND ejo.id IN (?)`,
    [estimateId, submittedIds]
  );
  if (lines.length !== submittedIds.length) {
    return res.status(400).json({ error: 'One of the selected items is no longer on this Estimate.' });
  }

  const num = (v) => Number(v || 0);
  const subtotal = lines.reduce((s, l) => s + num(l.subtotal), 0);
  const discountAmount = lines.reduce((s, l) => s + num(l.disc_amount), 0);
  const netOfTax = lines.reduce((s, l) => s + num(l.net_of_tax), 0);
  const taxAmount = lines.reduce((s, l) => s + num(l.tax_amount), 0);
  const grossAmount = lines.reduce((s, l) => s + num(l.gross_amount), 0);
  const ewtAmount = netOfTax * (num(withholdingTaxPct) / 100);
  const amountDue = grossAmount - ewtAmount;
  await assertPeriodOpen(dateCreated, 'ar', conn);

  await conn.beginTransaction();
  const [result] = await conn.query(
    `INSERT INTO sales_invoices
       (invoice_no, sales_order_id, estimate_id, date_created, date_due, term, bs_si_no, po_no, sales_rep_id,
        office_location_id, department_id, bill_to_address, memo, withholding_tax_pct, subtotal,
        discount_amount, net_of_tax, ewt_amount, tax_amount, gross_amount, amount_due, created_by_user_id)
     VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      est.sales_order_id || null,
      estimateId, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null, term || null,
      bsSiNo || null, poNo || null, salesRepId || null, officeLocationId || null, departmentId || null,
      billToAddress || null, memo || null, withholdingTaxPct || 0, subtotal, discountAmount, netOfTax,
      ewtAmount, taxAmount, grossAmount, amountDue, req.user.id,
    ]
  );
  const invoiceId = result.insertId;
  await conn.query('UPDATE sales_invoices SET invoice_no = ? WHERE id = ?', [`INV-${invoiceId}`, invoiceId]);

  for (const l of lines) {
    await conn.query(
      `INSERT INTO sales_invoice_lines
         (sales_invoice_id, sales_order_line_id, estimate_job_order_id, job_type_id, job_order_id, description,
          job_location_id, quantity, units, price_per_unit, subtotal, disc_percent, disc_amount,
          disc_price_per_unit, net_of_tax, tax_code, tax_amount, gross_amount)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceId, l.id, l.job_type_id, l.job_order_id || null, l.description, l.job_location_id, l.quantity, l.units,
        l.price_per_unit, l.subtotal, l.disc_percent, l.disc_amount, l.disc_price_per_unit,
        l.net_of_tax, l.tax_code, l.tax_amount, l.gross_amount,
      ]
    );
  }

  await logAudit(conn, {
    invoiceId, userId: req.user.id, eventType: 'Created', fieldName: 'invoice_no', newValue: `INV-${invoiceId}`,
  });
  await logAudit(conn, {
    invoiceId, userId: req.user.id, eventType: 'Created', fieldName: 'estimate_id', newValue: est.estimate_no,
  });
  await conn.commit();

  const [[row]] = await pool.query('SELECT * FROM sales_invoices WHERE id = ?', [invoiceId]);
  return res.status(201).json(row);
}

// Which permission a create needs depends on what is being created.
//
// Raising an invoice against an Estimate is an ADD -- Create New on the invoice list, a new
// document off a document that is not itself changed by it. Billing a Sales Order or a Delivery
// Ticket is not: those move job_orders.quantity_invoiced, recompute the order's status, or flip a
// ticket to converted, which is amending work that already exists. So they keep requiring
// can_edit, and only the Estimate path answers to can_add.
//
// Nobody loses anything by this: every account currently holding can_edit on this page also holds
// can_add, so the button's audience only grows -- by the four Sales accounts that had can_add and
// no way to use it.
// ...EXCEPT outside Head Office, where BILLING IS THE REP'S OWN JOB.
//
// Those two actions assume a separation of duties that only exists at Head Office: someone raises
// the order, Accounting down the corridor turns it into an invoice. A branch has no Accounting
// desk. The rep who took the order is the person who bills it, so the permission that models "may
// this account hand work to Accounting" has nothing to say about them -- and it was refusing them
// on a rule written for an office they do not work in.
//
// So for a user whose default location is not Head Office, holding the Sales Invoices page at all
// (can_view) is enough to raise one. This is deliberately looser than can_add: the branch accounts
// carry view-only rows -- Roselyn Tundag, who this was reported from, has can_view and neither of
// the other two -- so asking for can_add would have changed the error message and nothing else.
// Head Office is untouched and still answers to can_add / can_edit as before.
//
// An account with NO default location at all counts as Head Office, i.e. the stricter side; see
// lib/userLocation.js. The location comes from the account, never from the request, so this cannot
// be steered by what gets posted.
async function requireInvoiceCreatePermission(req, res, next) {
  try {
    if (!(await isHeadOfficeUser(req.user.id))) {
      if (await userCan(req.user.id, ROUTE, 'can_view')) return next();
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    const action = req.body?.estimate_id ? 'can_add' : 'can_edit';
    if (await userCan(req.user.id, ROUTE, action)) return next();
    return res.status(403).json({ error: 'You do not have permission to perform this action' });
  } catch (err) {
    return next(err);
  }
}

router.post('/', requireAuth, requireInvoiceCreatePermission, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      sales_order_id: salesOrderId, date_created: dateCreated, date_due: dateDue, term, bs_si_no: bsSiNo,
      po_no: poNo, sales_rep_id: salesRepId, office_location_id: officeLocationId, department_id: departmentId,
      bill_to_address: billToAddress, memo, withholding_tax_pct: withholdingTaxPct, sales_order_line_ids: lineIds,
    } = req.body;

    // Raising an invoice against an Estimate is its own path: no Sales Order, no Job Orders, and
    // so nothing to net off or to advance a status on. Checked before the Sales Order guard below,
    // which would otherwise reject it for the very thing that makes it what it is.
    if (req.body.estimate_id) {
      return billEstimate(req, res, conn);
    }

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
    await assertPeriodOpen(dateCreated, 'ar', conn);

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
    const [[si]] = await conn.query('SELECT status, sales_order_id, delivery_ticket_id, date_created FROM sales_invoices WHERE id = ?', [req.params.id]);
    if (si) await assertPeriodOpen(si.date_created, 'ar', conn);
    if (!si) return res.status(404).json({ error: 'Not found' });
    if (si.status === 'cancelled') return res.status(409).json({ error: 'This Sales Invoice is already cancelled.' });

    const [lines] = await conn.query(
      'SELECT job_order_id, sales_order_line_id, estimate_job_order_id, quantity FROM sales_invoice_lines WHERE sales_invoice_id = ?',
      [req.params.id]
    );

    await conn.beginTransaction();
    for (const l of lines) {
      // Give back only what was taken. An estimate-sourced line carries a job_order_id for
      // reference -- so the invoice shows the JO # the work became -- but billing it never
      // advanced quantity_invoiced, so giving that quantity back here would credit a job order
      // for an invoice that never debited it.
      if (l.job_order_id && !l.estimate_job_order_id) {
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
    // The invoice keeps posting its original entry (lib/glImpact.js no longer excludes a cancelled
    // one); this is what takes it back out, dated today rather than back in the invoice's own
    // period. Read the header and lines fresh so the reversal mirrors exactly what the GL Impact
    // tab shows for this invoice.
    const [[fullSi]] = await conn.query('SELECT * FROM sales_invoices WHERE id = ?', [req.params.id]);
    const [glLines] = await conn.query('SELECT * FROM sales_invoice_lines WHERE sales_invoice_id = ?', [req.params.id]);
    const reversal = await postReversalJournal(conn, {
      sourceType: 'sales_invoice', sourceId: Number(req.params.id), sourceNo: fullSi.invoice_no,
      glRows: await computeSalesInvoiceGl(fullSi, glLines),
      documentDate: fullSi.date_created, voidedAt: new Date(),
      reason: req.body?.reason || null, userId: req.user.id, locationId: fullSi.office_location_id || null,
    });
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
    if (reversal) {
      await logAudit(conn, {
        invoiceId: req.params.id, userId: req.user.id, eventType: 'Created',
        fieldName: 'reversal_journal_no', newValue: reversal.journalNo,
      });
    }
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM sales_invoices WHERE id = ?', [req.params.id]);
    res.json({ ...row, reversal_journal_no: reversal?.journalNo || null });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
