const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Treasury > Collection Report with Aging (asked 2026-10-09). The Customer Payments in a date
// range, one row per invoice each payment settled, with how old the invoice was when the money
// came in -- so Treasury can see what was collected inside 30 days and what was chased for months.
//
//   Age at Collection   payment date - invoice date. What the buckets are on.
//   Days Past Due       payment date - invoice due date; 0 or less means collected on time.
//
// Its own permission page, like the Disbursement Report: reading collections across customers is
// Treasury's question, not the same right as raising a Customer Payment.
const ROUTE = '/treasury/collection-aging';

// Voided payments never collected anything. Lines applying a credit memo rather than an invoice
// are not collections either.
//
// CPAY-INV-#### rows are not receipts: db/generate-invoice-payments.js wrote one per already-paid
// imported invoice so the module had history; no money arrived on that day (see
// routes/collectionForecast.js REAL_PAYMENT). Left out unless asked for, or every imported invoice
// would read as collected on whatever day the generator chose.
const REAL_PAYMENT = "cp.customer_payment_no NOT LIKE 'CPAY-INV-%'";

const BUCKETS = [
  { key: '0-30', label: '0–30 days', min: -Infinity, max: 30 },
  { key: '31-60', label: '31–60 days', min: 31, max: 60 },
  { key: '61-90', label: '61–90 days', min: 61, max: 90 },
  { key: '91-120', label: '91–120 days', min: 91, max: 120 },
  { key: '120+', label: 'Over 120 days', min: 121, max: Infinity },
];
const bucketOf = (age) => (age == null ? null : BUCKETS.find((b) => age >= b.min && age <= b.max).key);

const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
function range(query) {
  const today = new Date().toISOString().slice(0, 10);
  const from = isIsoDate(query.from) ? query.from : today;
  const to = isIsoDate(query.to) ? query.to : today;
  return from <= to ? { from, to } : { from: to, to: from };
}

async function fetchRows(query) {
  const { from, to } = range(query);
  const where = ["cp.status <> 'voided'", 'cpl.sales_invoice_id IS NOT NULL', 'cp.date_created BETWEEN ? AND ?'];
  const params = [from, to];
  if (query.include_generated !== '1') where.push(REAL_PAYMENT);
  if (Number(query.customer_id) > 0) { where.push('cp.customer_id = ?'); params.push(Number(query.customer_id)); }
  if (query.search) {
    where.push('(cp.customer_payment_no LIKE ? OR si.invoice_no LIKE ? OR cp.or_no LIKE ? OR c.name LIKE ?)');
    const like = `%${query.search}%`;
    params.push(like, like, like, like);
  }
  const [rows] = await pool.query(
    `SELECT cp.id AS payment_id, cp.customer_payment_no, cp.date_created AS payment_date, cp.or_no,
            c.name AS customer_name, si.id AS invoice_id, si.invoice_no, si.date_created AS invoice_date,
            si.date_due, cpl.applied_amount,
            DATEDIFF(cp.date_created, si.date_created) AS age_days,
            DATEDIFF(cp.date_created, si.date_due) AS days_past_due
       FROM customer_payment_lines cpl
       JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
       JOIN sales_invoices si ON si.id = cpl.sales_invoice_id
       LEFT JOIN customers c ON c.id = cp.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY cp.date_created, cp.customer_payment_no, si.invoice_no`,
    params,
  );
  let out = rows.map((r) => ({
    ...r,
    age_days: r.age_days == null ? null : Number(r.age_days),
    days_past_due: r.days_past_due == null ? null : Number(r.days_past_due),
    applied_amount: Number(r.applied_amount || 0),
    bucket: bucketOf(r.age_days == null ? null : Number(r.age_days)),
  }));
  // The summary is over the whole range; the bucket filter only narrows the rows listed.
  const summary = BUCKETS.map((b) => {
    const inB = out.filter((r) => r.bucket === b.key);
    return { key: b.key, label: b.label, count: inB.length, amount: inB.reduce((s, r) => s + r.applied_amount, 0) };
  });
  if (BUCKETS.some((b) => b.key === query.bucket)) out = out.filter((r) => r.bucket === query.bucket);
  return { from, to, rows: out, summary };
}

router.get('/customers', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.name FROM customers c
        WHERE c.id IN (SELECT DISTINCT customer_id FROM customer_payments WHERE status <> 'voided')
        ORDER BY c.name`);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const data = await fetchRows(req.query);
    res.json({ ...data, total_amount: data.rows.reduce((s, r) => s + r.applied_amount, 0) });
  } catch (err) { next(err); }
});

// Dates as plain YYYY-MM-DD text, as the Disbursement Report writes them (no timezone drift).
const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');
const bucketLabel = (k) => (BUCKETS.find((b) => b.key === k) || {}).label || '';

router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { from, to, rows } = await fetchRows(req.query);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Collection Aging');
    ws.columns = [
      { header: 'CPAY #', key: 'cpay', width: 16 },
      { header: 'Payment Date', key: 'payment_date', width: 13 },
      { header: 'OR #', key: 'or_no', width: 12 },
      { header: 'Customer', key: 'customer', width: 38 },
      { header: 'Invoice #', key: 'invoice_no', width: 15 },
      { header: 'Invoice Date', key: 'invoice_date', width: 13 },
      { header: 'Invoice Due Date', key: 'date_due', width: 15 },
      { header: 'Age at Collection (days)', key: 'age', width: 14 },
      { header: 'Days Past Due', key: 'past_due', width: 12 },
      { header: 'Aging', key: 'bucket', width: 14 },
      { header: 'Amount Collected', key: 'amount', width: 16 },
    ];
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow({
      cpay: r.customer_payment_no, payment_date: day(r.payment_date), or_no: r.or_no || '',
      customer: r.customer_name || '', invoice_no: r.invoice_no, invoice_date: day(r.invoice_date),
      date_due: day(r.date_due), age: r.age_days, past_due: r.days_past_due,
      bucket: bucketLabel(r.bucket), amount: r.applied_amount,
    }));
    ws.getColumn('amount').numFmt = '#,##0.00';
    ws.autoFilter = { from: 'A1', to: `K${rows.length + 1}` };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="collection-aging-${from}-to-${to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

module.exports = router;
