const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const SALES_ROUTE = '/reports/bir-sales';
const PURCHASE_ROUTE = '/reports/bir-purchase';

// BIR Reports -- the two listings the BIR filings are prepared from, mirroring the live system's
// "BIR Reports" menu column for column (app/main/bir-reports/{sales,purchase}-report).
//
//   Sales Report     one row per CUSTOMER PAYMENT -- money actually received, with the OR number
//                    and the customer's tax identity beside it. Not invoices: the filing is on
//                    receipts, which is why the live report keys on the payment and prints its
//                    OR, and why its export is named CustomerPayment.xls.
//   Purchase Report  one row per VENDOR BILL, carrying the VAT split the filing needs -- net of
//                    tax, tax, gross, withholding, and the net actually payable.
//
// Both are read-only listings with no totals row, again matching the live pages: the filing tool
// sums them, and a total that disagreed with the filing would be worse than no total.

const clampPage = (v) => Math.max(1, Number(v) || 1);
const clampLimit = (v) => Math.min(500, Math.max(1, Number(v) || 25));

// The live pages offer "As of" (everything up to a date) or "Period from" (between two).
// An absent or unrecognised filter means no date restriction at all, same as leaving it blank
// there -- a report that silently defaulted to a window would under-report a filing.
function dateClause(query, column) {
  const { date_filter: filter, from, to } = query;
  if (filter === 'as of' && to) return { sql: ` AND ${column} <= ?`, params: [to] };
  if (filter === 'period from' && from && to) return { sql: ` AND ${column} BETWEEN ? AND ?`, params: [from, to] };
  if (!filter && from && to) return { sql: ` AND ${column} BETWEEN ? AND ?`, params: [from, to] };
  if (!filter && to) return { sql: ` AND ${column} <= ?`, params: [to] };
  return { sql: '', params: [] };
}

// The live Status dropdown offers APPLIED / UNAPPLIED / DEPOSITED / NOT DEPOSITED / VOID. Those
// are two different questions about the same payment -- how much of it has been applied to an
// invoice, and whether the cash has been swept to the bank -- so they are expressed against the
// columns that actually answer each, rather than against `status` alone, which only ever holds
// deposited / not_deposited here.
function statusClause(status) {
  switch (String(status || '').toUpperCase()) {
    case 'APPLIED': return { sql: ' AND cp.voided_at IS NULL AND COALESCE(cp.applied_amount, 0) > 0', params: [] };
    case 'UNAPPLIED': return { sql: ' AND cp.voided_at IS NULL AND COALESCE(cp.unapplied_amount, 0) > 0', params: [] };
    case 'DEPOSITED': return { sql: " AND cp.voided_at IS NULL AND cp.status = 'deposited'", params: [] };
    case 'NOT DEPOSITED': return { sql: " AND cp.voided_at IS NULL AND cp.status = 'not_deposited'", params: [] };
    case 'VOID': return { sql: ' AND cp.voided_at IS NOT NULL', params: [] };
    default: return { sql: '', params: [] };
  }
}

// Supplier and customer addresses are stored multi-line. Quoting alone makes that valid CSV,
// but a filing file that is one row per line is far easier to check, so whitespace is collapsed.
const csvCell = (v) => `"${v == null ? '' : String(v).replace(/\s+/g, ' ').trim().replace(/"/g, '""')}"`;
function csvBody(headers, rows, pick) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(pick(r).map(csvCell).join(','));
  return lines.join('\n');
}
const today = () => new Date().toISOString().slice(0, 10);

// ---- BIR Reports > Sales Report ----
//
// Customer Address COALESCEs the customer's own address with a Billing row in customer_addresses:
// customers.address is the field the Customer screen fills, customer_addresses is the older table
// that currently holds no rows, and whichever gains data first starts printing here.
router.get('/sales', requireAuth, requirePermission(SALES_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, customer_id: customerId, location_id: locationId, status } = req.query;
    const where = ['1 = 1'];
    const params = [];

    if (customerId) { where.push('cp.customer_id = ?'); params.push(customerId); }
    if (locationId) { where.push('cp.office_location_id = ?'); params.push(locationId); }
    if (search) {
      where.push('(cp.customer_payment_no LIKE ? OR cp.or_no LIKE ? OR c.name LIKE ? OR c.tin LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    const st = statusClause(status);
    const dt = dateClause(req.query, 'cp.date_created');
    const whereSql = `WHERE ${where.join(' AND ')}${st.sql}${dt.sql}`;
    const whereParams = [...params, ...st.params, ...dt.params];

    const baseFrom = `FROM customer_payments cp
       JOIN customers c ON c.id = cp.customer_id
       LEFT JOIN locations loc ON loc.id = cp.office_location_id
       LEFT JOIN taxes t ON t.id = c.tax_id
       LEFT JOIN customer_addresses ca
              ON ca.customer_id = c.id AND ca.address_type = 'Billing'`;

    const select = `SELECT cp.id, cp.customer_payment_no, cp.date_created, cp.or_no,
              cp.payment_amount AS total_amount, cp.status, cp.voided_at,
              c.name AS customer_name, c.tin AS customer_tin,
              t.code AS customer_tax_code,
              COALESCE(NULLIF(c.address, ''), ca.address_line) AS customer_address,
              loc.location_name`;

    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const [rows] = await pool.query(
        `${select} ${baseFrom} ${whereSql} ORDER BY cp.date_created DESC, cp.id DESC`, whereParams,
      );
      const csv = csvBody(
        ['Customer Payment No', 'Date Created', 'Customer', 'Location', 'OR', 'Total Amount',
          'Customer Tax Code', 'Customer TIN', 'Customer Address'],
        rows,
        (r) => [r.customer_payment_no, r.date_created, r.customer_name, r.location_name, r.or_no,
          r.total_amount, r.customer_tax_code, r.customer_tin, r.customer_address],
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="bir-sales-report-${today()}.csv"`);
      return res.send(csv);
    }

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${whereSql}`, whereParams);
    const page = clampPage(req.query.page);
    const limit = clampLimit(req.query.limit);
    const [rows] = await pool.query(
      `${select} ${baseFrom} ${whereSql}
       ORDER BY cp.date_created DESC, cp.id DESC LIMIT ? OFFSET ?`,
      [...whereParams, limit, (page - 1) * limit],
    );
    return res.json({ rows, total, page, limit });
  } catch (err) {
    return next(err);
  }
});

// ---- BIR Reports > Purchase Report ----
//
// "Created From" is the purchase order the bill was raised against -- the live column of the same
// name shows the source document, not the bill's own number.
router.get('/purchase', requireAuth, requirePermission(PURCHASE_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, supplier_id: supplierId } = req.query;
    const where = ['1 = 1'];
    const params = [];

    if (supplierId) { where.push('po.supplier_id = ?'); params.push(supplierId); }
    if (search) {
      where.push('(vb.bill_no LIKE ? OR vb.reference_no LIKE ? OR po.po_no LIKE ? OR s.name LIKE ? OR s.tin LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }

    const dt = dateClause(req.query, 'vb.date_created');
    const whereSql = `WHERE ${where.join(' AND ')}${dt.sql}`;
    const whereParams = [...params, ...dt.params];

    const baseFrom = `FROM vendor_bills vb
       LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id`;

    const select = `SELECT vb.id, vb.bill_no, po.po_no AS created_from, vb.reference_no,
              vb.date_created, s.name AS supplier_name,
              vb.net_of_tax, vb.tax_amount, vb.gross_amount AS total_amount,
              vb.wtax_amount,
              -- Net Amount is COMPUTED, not read from vendor_bills.amount_due. That column does hold
              -- gross minus withholding for bills raised here, but it is 0 on the 18,762 imported
              -- bills of 19,164 -- the import never filled it. Deriving it is right for every row
              -- and cannot disagree with the Total and Withholding columns printed beside it.
              (COALESCE(vb.gross_amount, 0) - COALESCE(vb.wtax_amount, 0)) AS net_amount,
              s.tin AS supplier_tin, s.address AS supplier_address`;

    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const [rows] = await pool.query(
        `${select} ${baseFrom} ${whereSql} ORDER BY vb.date_created DESC, vb.id DESC`, whereParams,
      );
      const csv = csvBody(
        ['Vendor Bill No', 'Created From', 'Reference No', 'Date Created', 'Vendor', 'Net of Tax',
          'Tax Amount', 'Total Amount', 'Withholding Tax Amount', 'Net Amount', 'Supplier TIN',
          'Supplier Address'],
        rows,
        (r) => [r.bill_no, r.created_from, r.reference_no, r.date_created, r.supplier_name,
          r.net_of_tax, r.tax_amount, r.total_amount, r.wtax_amount, r.net_amount,
          r.supplier_tin, r.supplier_address],
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="bir-purchase-report-${today()}.csv"`);
      return res.send(csv);
    }

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${whereSql}`, whereParams);
    const page = clampPage(req.query.page);
    const limit = clampLimit(req.query.limit);
    const [rows] = await pool.query(
      `${select} ${baseFrom} ${whereSql} ORDER BY vb.date_created DESC, vb.id DESC LIMIT ? OFFSET ?`,
      [...whereParams, limit, (page - 1) * limit],
    );
    return res.json({ rows, total, page, limit });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
