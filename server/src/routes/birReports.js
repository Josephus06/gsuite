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
    const where = ['(drp.dr_amount IS NULL OR cp.payment_amount - drp.dr_amount > 0.005)'];
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

    // Delivery Receipts are not BIR sales invoices. This report lists payments, so the part of a
    // payment applied to DR invoices comes off its amount, and a payment applied wholly to DRs
    // is not listed. An unapplied balance stays -- nothing yet says it is for a DR.
    const baseFrom = `FROM customer_payments cp
       JOIN customers c ON c.id = cp.customer_id
       LEFT JOIN (SELECT cpl.customer_payment_id, SUM(cpl.applied_amount) AS dr_amount
                    FROM customer_payment_lines cpl
                    JOIN sales_invoices si ON si.id = cpl.sales_invoice_id
                   WHERE si.invoice_type = 'DR'
                   GROUP BY cpl.customer_payment_id) drp ON drp.customer_payment_id = cp.id
       LEFT JOIN locations loc ON loc.id = cp.office_location_id
       LEFT JOIN taxes t ON t.id = c.tax_id
       LEFT JOIN customer_addresses ca
              ON ca.customer_id = c.id AND ca.address_type = 'Billing'`;

    const select = `SELECT cp.id, cp.customer_payment_no, cp.date_created, cp.or_no,
              cp.payment_amount - COALESCE(drp.dr_amount, 0) AS total_amount, cp.status, cp.voided_at,
              c.id AS customer_id, c.name AS customer_name, c.tin AS customer_tin,
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

    if (supplierId) { where.push('COALESCE(po.supplier_id, vb.supplier_id) = ?'); params.push(supplierId); }
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
       LEFT JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id)`;

    const select = `SELECT vb.id, vb.bill_no, po.po_no AS created_from, vb.reference_no,
              vb.date_created, s.id AS supplier_id, s.name AS supplier_name,
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

/* ========================================================================================== */
/* Tax reports (asked 2026-10-21): Expanded Withholding Tax, Creditable Withholding Tax (2307  */
/* from customers) and the VAT computation. One month at a time (?month=YYYY-MM, default the   */
/* month before this one for EWT / VAT -- the one being filed -- and this month for 2307s),    */
/* with that month's deadline (lib/birDeadlines.js), totals, and ?format=csv for the details.  */
/* ========================================================================================== */
const { monthRange, deadlineInfo, manilaToday } = require('../lib/birDeadlines');

const EWT_ROUTE = '/reports/bir-ewt';
const CWT_ROUTE = '/reports/bir-cwt';
const VAT_ROUTE = '/reports/bir-vat';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const lastMonth = () => { const t = manilaToday(); let [y, m] = t.slice(0, 7).split('-').map(Number); m -= 1; if (m < 1) { m = 12; y -= 1; } return `${y}-${String(m).padStart(2, '0')}`; };

function monthOf(req, fallback) {
  const range = monthRange(req.query.month || fallback);
  if (!range) { const e = new Error('month must be YYYY-MM.'); e.status = 400; throw e; }
  return range;
}
function sendCsv(res, name, headers, rows, pick) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  return res.send(csvBody(headers, rows, pick));
}
const fail = (res, next, err) => (err.status ? res.status(err.status).json({ error: err.message }) : next(err));

// ---- Expanded Withholding Tax ----
//
// What we withheld from suppliers in the month, for the 0619-E / 1601-EQ and the QAP:
//   Vendor Bills   wtax_amount, under the bill's withholding tax (its ATC and rate). The tax base is
//                  the net of VAT of the lines marked Withhold, or the whole bill's net when none is.
//   Bill Credits   their withholding, taken back (negative).
//   Cheques        the withholding on direct cheques -- they carry no ATC, so "Not set".
// Cancelled / voided documents are left out. Due the 5th of the following month.
router.get('/ewt', requireAuth, requirePermission(EWT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const m = monthOf(req, lastMonth());
    const [bills] = await pool.query(
      `SELECT 'Vendor Bill' AS doc_type, vb.id, vb.bill_no AS doc_no, vb.date_created, vb.reference_no,
              s.id AS supplier_id, s.name AS supplier_name, s.tin AS supplier_tin, s.address AS supplier_address,
              COALESCE(w.atc_code, w.code) AS atc, COALESCE(w.name, vb.wtax_description) AS nature, w.rate,
              COALESCE(wl.base, vb.net_of_tax) AS tax_base, vb.wtax_amount
         FROM vendor_bills vb
         LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
         LEFT JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id)
         LEFT JOIN withholding_taxes w ON w.id = vb.wtax_id
         LEFT JOIN (SELECT vendor_bill_id, SUM(net_of_tax) AS base FROM vendor_bill_lines WHERE is_withhold = 1 GROUP BY vendor_bill_id) wl
                ON wl.vendor_bill_id = vb.id
        WHERE vb.date_created BETWEEN ? AND ? AND vb.status <> 'cancelled' AND vb.wtax_amount > 0`, [m.from, m.to]);
    const [credits] = await pool.query(
      `SELECT 'Bill Credit' AS doc_type, bc.id, bc.bill_credit_no AS doc_no, bc.date_created, NULL AS reference_no,
              s.id AS supplier_id, s.name AS supplier_name, s.tin AS supplier_tin, s.address AS supplier_address,
              COALESCE(w.atc_code, w.code) AS atc, COALESCE(w.name, bc.wtax_description) AS nature, w.rate,
              -bc.subtotal AS tax_base, -bc.wtax_amount AS wtax_amount
         FROM bill_credits bc
         LEFT JOIN suppliers s ON s.id = bc.supplier_id
         LEFT JOIN withholding_taxes w ON w.id = bc.wtax_id
        WHERE bc.date_created BETWEEN ? AND ? AND bc.status <> 'void' AND bc.wtax_amount > 0`, [m.from, m.to]);
    const [cheques] = await pool.query(
      `SELECT 'Cheque' AS doc_type, ch.id, ch.cheque_no AS doc_no, ch.date_created, ch.cheque_number AS reference_no,
              s.id AS supplier_id, COALESCE(s.name, ch.payee_name) AS supplier_name, s.tin AS supplier_tin, s.address AS supplier_address,
              NULL AS atc, NULL AS nature, NULL AS rate, ch.net_of_tax AS tax_base, ch.withholding_tax_amount AS wtax_amount
         FROM cheques ch
         LEFT JOIN suppliers s ON ch.payee_type IN ('VENDOR', 'supplier') AND s.id = ch.payee_id
        WHERE ch.date_created BETWEEN ? AND ? AND ch.status <> 'void' AND ch.withholding_tax_amount > 0`, [m.from, m.to]);
    const rows = [...bills, ...credits, ...cheques]
      .map((r) => ({ ...r, atc: r.atc || 'Not set', tax_base: r2(r.tax_base), wtax_amount: r2(r.wtax_amount) }))
      .sort((a, b) => String(a.atc).localeCompare(String(b.atc)) || String(a.date_created).localeCompare(String(b.date_created)));

    if (String(req.query.format).toLowerCase() === 'csv') {
      return sendCsv(res, `bir-ewt-${m.month}.csv`,
        ['ATC', 'Nature of Income Payment', 'Rate %', 'Document', 'No.', 'Date', 'Reference', 'Supplier', 'TIN', 'Address', 'Tax Base', 'Tax Withheld'],
        rows, (r) => [r.atc, r.nature, r.rate, r.doc_type, r.doc_no, r.date_created, r.reference_no, r.supplier_name, r.supplier_tin, r.supplier_address, r.tax_base, r.wtax_amount]);
    }
    const byAtc = new Map();
    for (const r of rows) {
      const k = r.atc;
      if (!byAtc.has(k)) byAtc.set(k, { atc: k, nature: r.nature, rate: r.rate, count: 0, tax_base: 0, wtax_amount: 0 });
      const a = byAtc.get(k); a.count += 1; a.tax_base += r.tax_base; a.wtax_amount += r.wtax_amount;
    }
    const summary = [...byAtc.values()].map((a) => ({ ...a, tax_base: r2(a.tax_base), wtax_amount: r2(a.wtax_amount) }));
    return res.json({
      ...m, deadline: deadlineInfo('ewt', m.month), rows, summary,
      totals: { count: rows.length, tax_base: r2(rows.reduce((s, r) => s + r.tax_base, 0)), wtax_amount: r2(rows.reduce((s, r) => s + r.wtax_amount, 0)) },
      no_atc: rows.filter((r) => r.atc === 'Not set').length,
    });
  } catch (err) { return fail(res, next, err); }
});

// ---- Creditable Withholding Tax (2307 from customers) ----
//
// The invoices of the month a customer withholds on (sales_invoices.ewt_amount), each with whether
// that customer's BIR 2307 has come in (customer_2307_receipts). The certificates are to be in by
// the END of the month. Also: how many from earlier months are still missing -- the last 12, but not
// before October 2026, when this tracking began (TRACKING_FROM) -- and the
// CWT credit memos of the month (credited to Creditable Withholding Tax, 14200) -- the CWT applied.
const TRACKING_FROM = '2026-10-01';
const CWT_FROM = `FROM sales_invoices si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
       LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)
       LEFT JOIN customer_2307_receipts r ON r.sales_invoice_id = si.id
       LEFT JOIN users ru ON ru.id = r.received_by_user_id`;

router.get('/cwt', requireAuth, requirePermission(CWT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const m = monthOf(req, manilaToday().slice(0, 7));
    const status = String(req.query.status || '');
    const where = ["si.status <> 'cancelled'", 'si.ewt_amount > 0', 'si.date_created BETWEEN ? AND ?'];
    const params = [m.from, m.to];
    if (status === 'received') where.push('r.sales_invoice_id IS NOT NULL');
    if (status === 'pending') where.push('r.sales_invoice_id IS NULL');
    if (req.query.search) {
      where.push('(si.invoice_no LIKE ? OR si.bs_si_no LIKE ? OR c.name LIKE ? OR r.certificate_no LIKE ?)');
      params.push(...Array(4).fill(`%${req.query.search}%`));
    }
    const [rows] = await pool.query(
      `SELECT si.id, si.invoice_no, si.bs_si_no, si.date_created, si.status AS invoice_status,
              c.id AS customer_id, c.name AS customer_name, c.tin AS customer_tin, c.address AS customer_address,
              si.net_of_tax AS tax_base, si.withholding_tax_pct AS rate, si.ewt_amount,
              r.received_date, r.certificate_no, r.remarks, ru.display_name AS received_by
         ${CWT_FROM} WHERE ${where.join(' AND ')}
        ORDER BY c.name, si.date_created, si.id`, params);

    if (String(req.query.format).toLowerCase() === 'csv') {
      return sendCsv(res, `bir-2307-${m.month}.csv`,
        ['Customer', 'TIN', 'Address', 'Invoice', 'BS/SI #', 'Date', 'Tax Base', 'Rate %', 'Tax Withheld', '2307 Received', 'Certificate No.', 'Remarks'],
        rows, (r) => [r.customer_name, r.customer_tin, r.customer_address, r.invoice_no, r.bs_si_no, r.date_created, r.tax_base, r.rate, r.ewt_amount,
          r.received_date || 'Not yet', r.certificate_no, r.remarks]);
    }
    const [[all]] = await pool.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(si.ewt_amount), 0) AS ewt,
              COALESCE(SUM(r.sales_invoice_id IS NOT NULL), 0) AS rec_n,
              COALESCE(SUM(IF(r.sales_invoice_id IS NOT NULL, si.ewt_amount, 0)), 0) AS rec_ewt
         FROM sales_invoices si LEFT JOIN customer_2307_receipts r ON r.sales_invoice_id = si.id
        WHERE si.status <> 'cancelled' AND si.ewt_amount > 0 AND si.date_created BETWEEN ? AND ?`, [m.from, m.to]);
    const yearBack = new Date(Date.parse(`${m.from}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10);
    const earlierFrom = yearBack > TRACKING_FROM ? yearBack : TRACKING_FROM;
    const [[earlier]] = await pool.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(si.ewt_amount), 0) AS ewt
         FROM sales_invoices si LEFT JOIN customer_2307_receipts r ON r.sales_invoice_id = si.id
        WHERE si.status <> 'cancelled' AND si.ewt_amount > 0 AND si.date_created >= ? AND si.date_created < ?
          AND r.sales_invoice_id IS NULL`, [earlierFrom, m.from]);
    const [[cms]] = await pool.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(cm.gross_amount), 0) AS amount
         FROM credit_memos cm JOIN chart_of_accounts a ON a.id = cm.source_account_id
        WHERE a.account_code = '14200' AND cm.voided_at IS NULL AND cm.date_created BETWEEN ? AND ?`, [m.from, m.to]);
    return res.json({
      ...m, deadline: deadlineInfo('cwt', m.month), rows,
      totals: {
        count: Number(all.n), ewt_amount: r2(all.ewt),
        received_count: Number(all.rec_n), received_amount: r2(all.rec_ewt),
        pending_count: Number(all.n) - Number(all.rec_n), pending_amount: r2(all.ewt - all.rec_ewt),
      },
      earlier_pending: { count: Number(earlier.n), ewt_amount: r2(earlier.ewt), since: earlierFrom },
      cwt_credit_memos: { count: Number(cms.n), amount: r2(cms.amount) },
    });
  } catch (err) { return fail(res, next, err); }
});

// Mark an invoice's 2307 received (date, certificate no., remarks), or take the mark off
// (received: false). Edit on the 2307 page.
router.put('/cwt/:invoiceId', requireAuth, requirePermission(CWT_ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const id = Number(req.params.invoiceId);
    const [[inv]] = await pool.query("SELECT id, invoice_no, ewt_amount, status FROM sales_invoices WHERE id = ?", [id]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    const [[before]] = await pool.query('SELECT received_date, certificate_no FROM customer_2307_receipts WHERE sales_invoice_id = ?', [id]);
    if (req.body.received === false) {
      await pool.query('DELETE FROM customer_2307_receipts WHERE sales_invoice_id = ?', [id]);
    } else {
      const date = String(req.body.received_date || '').slice(0, 10) || manilaToday();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date received must be YYYY-MM-DD.' });
      const certNo = String(req.body.certificate_no || '').trim().slice(0, 100) || null;
      const remarks = String(req.body.remarks || '').trim().slice(0, 500) || null;
      await pool.query(
        `INSERT INTO customer_2307_receipts (sales_invoice_id, received_date, certificate_no, remarks, received_by_user_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE received_date = VALUES(received_date), certificate_no = VALUES(certificate_no),
                                 remarks = VALUES(remarks), received_by_user_id = VALUES(received_by_user_id)`,
        [id, date, certNo, remarks, req.user.id]);
    }
    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('SalesInvoice', ?, 'Updated', '2307_received', ?, ?, ?)`,
      [id, before ? `${before.received_date}${before.certificate_no ? ` #${before.certificate_no}` : ''}` : 'not received',
        req.body.received === false ? 'not received' : `${String(req.body.received_date || manilaToday()).slice(0, 10)}${req.body.certificate_no ? ` #${String(req.body.certificate_no).trim()}` : ''}`,
        req.user.id]);
    const [[row]] = await pool.query(
      `SELECT r.received_date, r.certificate_no, r.remarks, ru.display_name AS received_by
         FROM customer_2307_receipts r LEFT JOIN users ru ON ru.id = r.received_by_user_id WHERE r.sales_invoice_id = ?`, [id]);
    return res.json(row || { received_date: null, certificate_no: null, remarks: null, received_by: null });
  } catch (err) { return next(err); }
});

// ---- VAT Computation ----
//
// Output Tax less Input Tax for the month (2550M/Q):
//   Output   Sales Invoice lines by their tax code -- VATable (12%), Zero-rated, Exempt -- less the
//            month's Credit Memo lines the same way (sales returns / allowances). Credit memo lines
//            that are not a return are left out (RETURN_LINE): those clearing a customer's
//            withholding (item WITHHOLDING TAX, or the memo credited to Creditable Withholding Tax,
//            14200) and write-offs (WRITE OFF/BAD DEBTS -- September's 2018-2020 balances).
//   Input    Vendor Bills' tax, plus direct Cheques' tax, less Bill Credits' tax. A bill with no tax
//            is a purchase that is not subject to VAT (non-VAT supplier, exempt).
// Cancelled / voided documents are left out. Due the 15th of the following month.
const VAT_CLASS = (col) => `CASE
    WHEN ${col} LIKE '%ZRATE%' OR ${col} LIKE '%0-VAT%' OR ${col} = 'VATPH_0' THEN 'zero_rated'
    WHEN ${col} LIKE '%EX%' THEN 'exempt'
    WHEN ${col} LIKE '%12%' THEN 'vatable'
    ELSE 'unclassified' END`;
// A credit memo line that is a sales return / allowance -- not a withholding clearance or a write-off.
const RETURN_LINE = `COALESCE(a.account_code, '') <> '14200'
  AND UPPER(COALESCE(cml.item_name, cml.description, '')) NOT LIKE '%WITHHOLDING%'
  AND UPPER(COALESCE(cml.item_name, cml.description, '')) NOT LIKE '%WRITE OFF%'
  AND UPPER(COALESCE(cml.item_name, cml.description, '')) NOT LIKE '%BAD DEBT%'`;
const OUTPUT_CLASSES = [['vatable', 'VATable sales (12%)'], ['zero_rated', 'Zero-rated sales'], ['exempt', 'VAT-exempt sales'], ['unclassified', 'No tax code']];

router.get('/vat', requireAuth, requirePermission(VAT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const m = monthOf(req, lastMonth());
    const [salesLines] = await pool.query(
      `SELECT ${VAT_CLASS('sil.tax_code')} AS cls, COUNT(DISTINCT si.id) AS docs,
              COALESCE(SUM(sil.net_of_tax), 0) AS net, COALESCE(SUM(sil.tax_amount), 0) AS tax
         FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id = sil.sales_invoice_id
        WHERE si.status <> 'cancelled' AND si.date_created BETWEEN ? AND ?
        GROUP BY cls`, [m.from, m.to]);
    const [cmLines] = await pool.query(
      `SELECT ${VAT_CLASS('cml.tax_code')} AS cls, COUNT(DISTINCT cm.id) AS docs,
              COALESCE(SUM(cml.net_of_tax), 0) AS net, COALESCE(SUM(cml.tax_amount), 0) AS tax
         FROM credit_memo_lines cml JOIN credit_memos cm ON cm.id = cml.credit_memo_id
         LEFT JOIN chart_of_accounts a ON a.id = cm.source_account_id
        WHERE cm.voided_at IS NULL AND cm.date_created BETWEEN ? AND ? AND ${RETURN_LINE}
        GROUP BY cls`, [m.from, m.to]);
    const sales = new Map(salesLines.map((r) => [r.cls, r]));
    const returns = new Map(cmLines.map((r) => [r.cls, r]));
    const output = OUTPUT_CLASSES.map(([key, label]) => {
      const s = sales.get(key) || {}; const c = returns.get(key) || {};
      return {
        key, label, invoices: Number(s.docs || 0), credit_memos: Number(c.docs || 0),
        gross_sales: r2(s.net), returns: r2(c.net), net_sales: r2((s.net || 0) - (c.net || 0)),
        output_tax: r2((s.tax || 0) - (c.tax || 0)),
      };
    }).filter((o) => o.key !== 'unclassified' || o.invoices || o.credit_memos);

    const [[vb]] = await pool.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(tax_amount > 0), 0) AS taxed_n,
              COALESCE(SUM(IF(tax_amount > 0, net_of_tax, 0)), 0) AS taxed_net,
              COALESCE(SUM(IF(tax_amount > 0, 0, net_of_tax)), 0) AS untaxed_net,
              COALESCE(SUM(tax_amount), 0) AS tax
         FROM vendor_bills WHERE status <> 'cancelled' AND date_created BETWEEN ? AND ?`, [m.from, m.to]);
    const [[ch]] = await pool.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(net_of_tax), 0) AS net, COALESCE(SUM(tax_amount), 0) AS tax
         FROM cheques WHERE status <> 'void' AND tax_amount > 0 AND date_created BETWEEN ? AND ?`, [m.from, m.to]);
    const [[bc]] = await pool.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(subtotal), 0) AS net, COALESCE(SUM(tax_amount), 0) AS tax
         FROM bill_credits WHERE status <> 'void' AND tax_amount > 0 AND date_created BETWEEN ? AND ?`, [m.from, m.to]);
    const input = [
      { key: 'vendor_bills', label: 'Vendor Bills (purchases subject to VAT)', count: Number(vb.taxed_n), net: r2(vb.taxed_net), input_tax: r2(vb.tax) },
      { key: 'cheques', label: 'Direct cheques', count: Number(ch.n), net: r2(ch.net), input_tax: r2(ch.tax) },
      { key: 'bill_credits', label: 'Less: Bill Credits', count: Number(bc.n), net: r2(-bc.net), input_tax: r2(-bc.tax) },
    ];
    const outputTax = r2(output.reduce((s, o) => s + o.output_tax, 0));
    const inputTax = r2(input.reduce((s, i) => s + i.input_tax, 0));

    if (String(req.query.format).toLowerCase() === 'csv') {
      const [docs] = await pool.query(
        `SELECT 'Output' AS side, 'Sales Invoice' AS doc_type, si.invoice_no AS doc_no, si.date_created,
                c.name AS party, c.tin, si.net_of_tax AS net, si.tax_amount AS tax
           FROM sales_invoices si
           LEFT JOIN sales_orders so ON so.id = si.sales_order_id LEFT JOIN estimates e ON e.id = si.estimate_id
           LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
           LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)
          WHERE si.status <> 'cancelled' AND si.date_created BETWEEN ? AND ?
         UNION ALL
         SELECT 'Output', 'Credit Memo', cm.credit_memo_no, cm.date_created, c.name, c.tin, -SUM(cml.net_of_tax), -SUM(cml.tax_amount)
           FROM credit_memos cm JOIN credit_memo_lines cml ON cml.credit_memo_id = cm.id
           LEFT JOIN customers c ON c.id = cm.customer_id
           LEFT JOIN chart_of_accounts a ON a.id = cm.source_account_id
          WHERE cm.voided_at IS NULL AND cm.date_created BETWEEN ? AND ? AND ${RETURN_LINE}
          GROUP BY cm.id
         UNION ALL
         SELECT 'Input', 'Vendor Bill', vb.bill_no, vb.date_created, s.name, s.tin, vb.net_of_tax, vb.tax_amount
           FROM vendor_bills vb LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
           LEFT JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id)
          WHERE vb.status <> 'cancelled' AND vb.date_created BETWEEN ? AND ?
         UNION ALL
         SELECT 'Input', 'Cheque', ch.cheque_no, ch.date_created, ch.payee_name, NULL, ch.net_of_tax, ch.tax_amount
           FROM cheques ch WHERE ch.status <> 'void' AND ch.tax_amount > 0 AND ch.date_created BETWEEN ? AND ?
         UNION ALL
         SELECT 'Input', 'Bill Credit', bc.bill_credit_no, bc.date_created, s.name, s.tin, -bc.subtotal, -bc.tax_amount
           FROM bill_credits bc LEFT JOIN suppliers s ON s.id = bc.supplier_id
          WHERE bc.status <> 'void' AND bc.tax_amount > 0 AND bc.date_created BETWEEN ? AND ?
         ORDER BY side DESC, doc_type, date_created`,
        [m.from, m.to, m.from, m.to, m.from, m.to, m.from, m.to, m.from, m.to]);
      return sendCsv(res, `bir-vat-${m.month}.csv`, ['Side', 'Document', 'No.', 'Date', 'Customer / Supplier', 'TIN', 'Net of VAT', 'VAT'],
        docs, (r) => [r.side, r.doc_type, r.doc_no, r.date_created, r.party, r.tin, r2(r.net), r2(r.tax)]);
    }
    return res.json({
      ...m, deadline: deadlineInfo('vat', m.month), output, input,
      purchases_not_subject_to_vat: { count: Number(vb.n) - Number(vb.taxed_n), net: r2(vb.untaxed_net) },
      totals: { output_tax: outputTax, input_tax: inputTax, vat_payable: r2(outputTax - inputTax) },
    });
  } catch (err) { return fail(res, next, err); }
});

/* ========================================================================================== */
/* BIR 2307 to Suppliers (asked 2026-11-05): the Certificate of Creditable Tax Withheld at      */
/* Source we owe each supplier we withheld EWT from, one per supplier per quarter -- the same    */
/* documents as the Expanded Withholding Tax report (vendor bills, bill credits taken back,      */
/* direct cheques), dated by the document, grouped by ATC with the three months of the quarter.  */
/* View lists and opens a form, Print prints it (logged), Edit changes the Payor details.        */
/* ========================================================================================== */
const ISSUE_ROUTE = '/reports/bir-2307';
const PAYOR_KEYS = {
  tin: 'bir_payor_tin', name: 'bir_payor_name', address: 'bir_payor_address', zip: 'bir_payor_zip',
  signatory: 'bir_payor_signatory', signatory_title: 'bir_payor_signatory_title', signatory_tin: 'bir_payor_signatory_tin',
};
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "2026-Q3" -> { quarter, from, to, label, months: ['2026-07', '2026-08', '2026-09'] }. Default: last quarter.
function quarterOf(req) {
  let q = String(req.query.quarter || '');
  if (!q) {
    const t = manilaToday(); let y = Number(t.slice(0, 4)); let n = Math.floor((Number(t.slice(5, 7)) - 1) / 3);
    if (n === 0) { n = 4; y -= 1; }
    q = `${y}-Q${n}`;
  }
  const mm = /^(\d{4})-Q([1-4])$/.exec(q);
  if (!mm) { const e = new Error('quarter must be YYYY-Q1..Q4.'); e.status = 400; throw e; }
  const y = Number(mm[1]); const n = Number(mm[2]);
  const months = [0, 1, 2].map((i) => `${y}-${String((n - 1) * 3 + 1 + i).padStart(2, '0')}`);
  const last = monthRange(months[2]);
  return {
    quarter: q, from: `${months[0]}-01`, to: last.to, months,
    label: `Q${n} ${y} (${MONTH_NAMES[(n - 1) * 3]} – ${MONTH_NAMES[(n - 1) * 3 + 2]})`,
  };
}

const payeeKey = (r) => (r.supplier_id ? `s${r.supplier_id}` : `n:${String(r.supplier_name || '').trim().toUpperCase()}`);

// Every document of the period we withheld on, one row each, with the payee's identity.
async function withheldDocs(from, to) {
  const [bills] = await pool.query(
    `SELECT 'Vendor Bill' AS doc_type, vb.id, vb.bill_no AS doc_no, vb.date_created, vb.reference_no,
            s.id AS supplier_id, s.name AS supplier_name, s.tin AS supplier_tin, s.address AS supplier_address,
            COALESCE(w.atc_code, w.code) AS atc, COALESCE(w.name, vb.wtax_description) AS nature, w.rate,
            COALESCE(wl.base, vb.net_of_tax) AS tax_base, vb.wtax_amount
       FROM vendor_bills vb
       LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id)
       LEFT JOIN withholding_taxes w ON w.id = vb.wtax_id
       LEFT JOIN (SELECT vendor_bill_id, SUM(net_of_tax) AS base FROM vendor_bill_lines WHERE is_withhold = 1 GROUP BY vendor_bill_id) wl
              ON wl.vendor_bill_id = vb.id
      WHERE vb.date_created BETWEEN ? AND ? AND vb.status <> 'cancelled' AND vb.wtax_amount > 0`, [from, to]);
  const [credits] = await pool.query(
    `SELECT 'Bill Credit' AS doc_type, bc.id, bc.bill_credit_no AS doc_no, bc.date_created, NULL AS reference_no,
            s.id AS supplier_id, s.name AS supplier_name, s.tin AS supplier_tin, s.address AS supplier_address,
            COALESCE(w.atc_code, w.code) AS atc, COALESCE(w.name, bc.wtax_description) AS nature, w.rate,
            -bc.subtotal AS tax_base, -bc.wtax_amount AS wtax_amount
       FROM bill_credits bc
       LEFT JOIN suppliers s ON s.id = bc.supplier_id
       LEFT JOIN withholding_taxes w ON w.id = bc.wtax_id
      WHERE bc.date_created BETWEEN ? AND ? AND bc.status <> 'void' AND bc.wtax_amount > 0`, [from, to]);
  const [cheques] = await pool.query(
    `SELECT 'Cheque' AS doc_type, ch.id, ch.cheque_no AS doc_no, ch.date_created, ch.cheque_number AS reference_no,
            s.id AS supplier_id, COALESCE(s.name, ch.payee_name) AS supplier_name, s.tin AS supplier_tin, s.address AS supplier_address,
            NULL AS atc, NULL AS nature, NULL AS rate, ch.net_of_tax AS tax_base, ch.withholding_tax_amount AS wtax_amount
       FROM cheques ch
       LEFT JOIN suppliers s ON ch.payee_type IN ('VENDOR', 'supplier') AND s.id = ch.payee_id
      WHERE ch.date_created BETWEEN ? AND ? AND ch.status <> 'void' AND ch.withholding_tax_amount > 0`, [from, to]);
  // Documents with no withholding tax chosen (every imported bill, every cheque) get an ATC
  // SUGGESTED from their effective rate: the Lookups withholding tax of that rate (the first by id
  // when two share it, e.g. WC160 / WI120 at 2%). Accounting confirms or changes it on the form.
  const options = await atcOptions();
  return [...bills, ...credits, ...cheques].map((r) => {
    const base = r2(r.tax_base); const tax = r2(r.wtax_amount);
    const atc = r.atc ? String(r.atc).replace(/\s+/g, '') : '';
    const effRate = base ? Math.round((tax / base) * 10000) / 100 : null;
    const guess = !atc && effRate != null ? options.find((o) => Math.abs(o.rate - effRate) <= 0.05) : null;
    return {
      ...r, atc: atc || (guess ? guess.atc : ''), atc_suggested: !atc && !!guess, eff_rate: effRate,
      nature: r.nature || (guess ? guess.nature : ''), rate: r.rate != null ? r.rate : (guess ? guess.rate : null),
      date_created: String(r.date_created instanceof Date ? r.date_created.toISOString() : r.date_created).slice(0, 10),
      tax_base: base, wtax_amount: tax, payee_key: payeeKey(r),
    };
  });
}

// Lookups > Withholding Taxes, as ATC choices for the form.
async function atcOptions() {
  const [rows] = await pool.query(
    `SELECT id, COALESCE(atc_code, code) AS atc, name AS nature, rate FROM withholding_taxes
      WHERE COALESCE(is_active, 1) = 1 AND COALESCE(atc_code, code) IS NOT NULL ORDER BY id`);
  return rows.map((r) => ({ ...r, atc: String(r.atc).replace(/\s+/g, ''), rate: Number(r.rate) }));
}

// Supplier addresses are stored as typed on the old system: the name again on the first line,
// "Philippines" on the last, the ZIP somewhere in between. The form wants one line plus the ZIP.
function splitAddress(address, name) {
  const lines = String(address || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .filter((l, i) => !(i === 0 && name && l.toUpperCase() === String(name).trim().toUpperCase()))
    .filter((l) => !/^philippines$/i.test(l));
  const text = lines.join(', ');
  const zips = text.match(/\b\d{4}\b/g);
  return { address: text, zip: zips ? zips[zips.length - 1] : '' };
}

async function loadPayor() {
  const [rows] = await pool.query('SELECT name, value FROM app_settings WHERE name IN (?)', [Object.values(PAYOR_KEYS)]);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.value || '']));
  return Object.fromEntries(Object.entries(PAYOR_KEYS).map(([k, n]) => [k, byName[n] || '']));
}

// The quarter's payees: what was withheld from each, what is missing for the form, and whether
// its 2307 has been printed.
router.get('/2307', requireAuth, requirePermission(ISSUE_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const q = quarterOf(req);
    const docs = await withheldDocs(q.from, q.to);
    const map = new Map();
    for (const d of docs) {
      if (!map.has(d.payee_key)) {
        map.set(d.payee_key, { key: d.payee_key, supplier_id: d.supplier_id, name: d.supplier_name, tin: d.supplier_tin, docs: 0, income: 0, tax: 0, no_atc: 0, suggested_atc: 0 });
      }
      const p = map.get(d.payee_key);
      p.docs += 1; p.income += d.tax_base; p.tax += d.wtax_amount;
      if (!d.atc) p.no_atc += 1; else if (d.atc_suggested) p.suggested_atc += 1;
    }
    const [issued] = await pool.query(
      `SELECT i.payee_key, COUNT(*) AS n, MAX(i.issued_at) AS last_at,
              (SELECT u.display_name FROM supplier_2307_issuances i2 LEFT JOIN users u ON u.id = i2.issued_by_user_id
                WHERE i2.quarter = i.quarter AND i2.payee_key = i.payee_key ORDER BY i2.issued_at DESC, i2.id DESC LIMIT 1) AS last_by
         FROM supplier_2307_issuances i WHERE i.quarter = ? GROUP BY i.quarter, i.payee_key`, [q.quarter]);
    const issuedBy = new Map(issued.map((i) => [i.payee_key, i]));
    const payees = [...map.values()]
      .map((p) => {
        const i = issuedBy.get(p.key);
        return { ...p, income: r2(p.income), tax: r2(p.tax), issued_count: i ? Number(i.n) : 0, last_issued_at: i ? i.last_at : null, last_issued_by: i ? i.last_by : null };
      })
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    return res.json({
      ...q, payees,
      totals: { payees: payees.length, issued: payees.filter((p) => p.issued_count).length, tax: r2(payees.reduce((s, p) => s + p.tax, 0)), income: r2(payees.reduce((s, p) => s + p.income, 0)) },
      payor: await loadPayor(),
    });
  } catch (err) { return fail(res, next, err); }
});

// One payee's form: Part I from the supplier, Part II from the Payor settings, Part III by ATC
// with the income payments of each month of the quarter and the tax withheld.
router.get('/2307/form', requireAuth, requirePermission(ISSUE_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const q = quarterOf(req);
    const key = String(req.query.payee || '');
    const docs = (await withheldDocs(q.from, q.to)).filter((d) => d.payee_key === key)
      .sort((a, b) => a.date_created.localeCompare(b.date_created));
    if (!docs.length) return res.status(404).json({ error: 'Nothing was withheld from this payee in the quarter.' });

    let payee = { name: docs[0].supplier_name || '', tin: docs[0].supplier_tin || '', address: docs[0].supplier_address || '' };
    if (docs[0].supplier_id) {
      const [[s]] = await pool.query('SELECT name, company_name, tin, address FROM suppliers WHERE id = ?', [docs[0].supplier_id]);
      if (s) payee = { name: s.company_name || s.name, tin: s.tin || '', address: s.address || '' };
    }
    const addr = splitAddress(payee.address, payee.name);

    const lines = new Map();
    for (const d of docs) {
      // No ATC even suggested: kept apart by effective rate so different rates never share a line.
      const k = d.atc || `?${d.eff_rate}`;
      if (!lines.has(k)) lines.set(k, { atc: d.atc, nature: d.nature || '', rate: d.rate != null ? d.rate : d.eff_rate, suggested: false, months: [0, 0, 0], tax: 0 });
      const l = lines.get(k);
      if (!l.nature && d.nature) l.nature = d.nature;
      if (d.atc_suggested) l.suggested = true;
      const mi = q.months.indexOf(d.date_created.slice(0, 7));
      if (mi >= 0) l.months[mi] += d.tax_base;
      l.tax += d.wtax_amount;
    }
    const out = [...lines.values()].map((l) => ({
      ...l, months: l.months.map(r2), total: r2(l.months.reduce((s, v) => s + v, 0)), tax: r2(l.tax),
    })).sort((a, b) => (a.atc ? 0 : 1) - (b.atc ? 0 : 1) || String(a.atc).localeCompare(String(b.atc)));

    return res.json({
      ...q,
      payee_key: key, supplier_id: docs[0].supplier_id || null,
      payee: { tin: payee.tin, name: payee.name, address: addr.address, zip: addr.zip },
      payor: await loadPayor(),
      lines: out,
      atc_options: await atcOptions(),
      totals: { months: [0, 1, 2].map((i) => r2(out.reduce((s, l) => s + l.months[i], 0))), total: r2(out.reduce((s, l) => s + l.total, 0)), tax: r2(out.reduce((s, l) => s + l.tax, 0)) },
      docs,
    });
  } catch (err) { return fail(res, next, err); }
});

// Printing a certificate is logged, so the list shows whose 2307 has gone out.
router.post('/2307/issued', requireAuth, requirePermission(ISSUE_ROUTE, 'can_print'), async (req, res, next) => {
  try {
    const q = quarterOf({ query: { quarter: req.body.quarter } });
    const key = String(req.body.payee_key || '').slice(0, 220);
    if (!key) return res.status(400).json({ error: 'payee_key is required.' });
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const row = {
      payee_key: key, supplier_id: Number(req.body.supplier_id) || null, payee_name: String(req.body.payee_name || '').slice(0, 200) || null,
      quarter: q.quarter, income_total: r2(req.body.income_total), tax_total: r2(req.body.tax_total), issued_by_user_id: req.user.id,
      // The period printed and, when not every document of the quarter, which ones (nos.) -- columns
      // added by a later run of add-bir-2307-issue.js, so only written once they exist.
      period_from: day(req.body.period_from), period_to: day(req.body.period_to),
      doc_refs: req.body.doc_refs ? String(req.body.doc_refs).slice(0, 1000) : null,
    };
    const [cols] = await pool.query('SHOW COLUMNS FROM supplier_2307_issuances');
    const have = new Set(cols.map((c) => c.Field));
    const keys = Object.keys(row).filter((k) => have.has(k));
    await pool.query(
      `INSERT INTO supplier_2307_issuances (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      keys.map((k) => row[k]));
    return res.json({ ok: true });
  } catch (err) { return fail(res, next, err); }
});

// The Payor details printed in Part II and on the signature line.
router.put('/2307/payor', requireAuth, requirePermission(ISSUE_ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const before = await loadPayor();
    for (const [k, name] of Object.entries(PAYOR_KEYS)) {
      if (req.body[k] === undefined) continue;
      const v = String(req.body[k] || '').replace(/\s+/g, ' ').trim().slice(0, 255);
      await pool.query('INSERT INTO app_settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [name, v]);
      if (v !== before[k]) {
        await pool.query(
          `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
           VALUES ('AppSetting', 0, 'Updated', ?, ?, ?, ?)`, [name, before[k], v, req.user.id]);
      }
    }
    return res.json(await loadPayor());
  } catch (err) { return fail(res, next, err); }
});

module.exports = router;
