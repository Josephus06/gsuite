const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

// Forecast Report -- every Job Order by the forecast date production set on it, with its status and
// its build / delivery / invoice progress, as the source's Production > Forecast Report.
//
// The forecast date is job_orders.planned_end_date: production sets it when scheduling (with the
// planned start), and the source's DateForecast was migrated onto it. A Job Order belongs to a Sales
// Order or a Non-Standard Sales Order, so customer, office, department and rep come from whichever
// it has.
const router = express.Router();
const ROUTE = '/reports/forecast';

// The source's single JO Status column, from T1S's status + production stage.
const STATUS_SQL = `CASE
    WHEN jo.status = 'Cancelled' THEN 'CANCELLED'
    WHEN jo.status = 'Pending RMA Approval' THEN 'PENDING RMA APPROVAL'
    WHEN jo.status LIKE 'Planned%' THEN 'PLANNED - PENDING FOR BOM'
    WHEN jo.production_stage IN ('completed', 'invoiced') THEN 'COMPLETED'
    WHEN jo.production_stage = 'partially_completed' THEN 'PARTIALLY COMPLETED'
    WHEN jo.production_stage = 'for_qi' THEN 'FOR QUALITY INSPECTION'
    WHEN jo.production_stage = 'pending_for_scheduling' THEN 'PENDING FOR SCHEDULING'
    WHEN jo.production_stage = 'for_revision' THEN 'FOR REVISION'
    ELSE 'JO IN-PROCESS' END`;
const STATUSES = ['PLANNED - PENDING FOR BOM', 'PENDING FOR SCHEDULING', 'JO IN-PROCESS', 'FOR REVISION', 'FOR QUALITY INSPECTION',
  'PARTIALLY COMPLETED', 'COMPLETED', 'PENDING RMA APPROVAL', 'CANCELLED'];

const FROM_SQL = `FROM job_orders jo
  LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
  LEFT JOIN non_standard_sales_orders ns ON ns.id = jo.nsso_id
  LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, ns.customer_id)
  LEFT JOIN locations ol ON ol.id = COALESCE(so.office_location_id, ns.office_location_id)
  LEFT JOIN locations jl ON jl.id = jo.job_location_id
  LEFT JOIN sales_divisions sd ON sd.id = COALESCE(so.sales_division_id, ns.sales_division_id)
  LEFT JOIN employees sr ON sr.id = COALESCE(jo.sales_rep_id, so.sales_rep_id, ns.sales_rep_id)
  LEFT JOIN job_types jt ON jt.id = jo.job_type_id
  LEFT JOIN sales_order_lines sol ON sol.id = jo.sales_order_line_id
  LEFT JOIN non_standard_sales_order_lines nl ON nl.id = jo.nsso_line_id`;

// Last build / delivery / invoice per Job Order, and what has been invoiced. Correlated, so they
// only run for the page of rows actually returned.
const SELECT_SQL = `SELECT jo.id, jo.job_order_no, jo.description, jo.quantity,
    c.name AS customer_name, ol.location_name AS office_location, jl.location_name AS job_location,
    sd.name AS department, CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep, jt.display_name AS job_type,
    COALESCE(so.sales_order_no, ns.nsso_no) AS order_no,
    COALESCE(sol.net_of_tax, nl.net_of_tax, 0) AS jo_amount,
    jo.delivery_date, jo.planned_end_date AS forecast_date, ${STATUS_SQL} AS jo_status,
    -- Prod Rating: the JO's GP against its job type's passing rate -- the commission report's rule.
    COALESCE(NULLIF(sol.gp_rate, 0), so.actual_gp_rate) AS gp_rate, jt.gp_rate_head AS passing_gp_rate,
    sol.is_approved_low_gp,
    (SELECT MAX(ab.date_created) FROM assembly_builds ab WHERE ab.job_order_id = jo.id AND ab.status <> 'cancelled') AS ab_date,
    (SELECT MAX(d.date_created) FROM item_delivery_lines idl JOIN item_deliveries d ON d.id = idl.item_delivery_id
      WHERE idl.job_order_id = jo.id AND d.status <> 'cancelled') AS id_date,
    (SELECT MAX(si.date_created) FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id = sil.sales_invoice_id
      WHERE sil.job_order_id = jo.id AND si.status <> 'cancelled') AS invoice_date,
    (SELECT COALESCE(SUM(sil.quantity), 0) FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id = sil.sales_invoice_id
      WHERE sil.job_order_id = jo.id AND si.status <> 'cancelled') AS invoice_qty,
    (SELECT COALESCE(SUM(sil.net_of_tax), 0) FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id = sil.sales_invoice_id
      WHERE sil.job_order_id = jo.id AND si.status <> 'cancelled') AS invoice_amount`;

function buildFilter(q) {
  const where = ['jo.planned_end_date IS NOT NULL'];
  const params = [];
  // Date Forecast: a month (default -- "extract per month"), everything up to a date, or a range.
  const mode = q.mode || 'month';
  if (mode === 'as_of' && q.as_of) { where.push('jo.planned_end_date <= ?'); params.push(q.as_of); }
  else if (mode === 'range') {
    if (q.from) { where.push('jo.planned_end_date >= ?'); params.push(q.from); }
    if (q.to) { where.push('jo.planned_end_date <= ?'); params.push(q.to); }
  } else {
    const month = /^\d{4}-\d{2}$/.test(String(q.month || '')) ? q.month : new Date().toISOString().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const start = `${month}-01`;
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    where.push('jo.planned_end_date BETWEEN ? AND ?'); params.push(start, end);
  }
  if (q.status) { where.push(`${STATUS_SQL} = ?`); params.push(q.status); }
  if (q.office_location_id) { where.push('COALESCE(so.office_location_id, ns.office_location_id) = ?'); params.push(q.office_location_id); }
  if (q.job_location_id) { where.push('jo.job_location_id = ?'); params.push(q.job_location_id); }
  if (q.department_id) { where.push('COALESCE(so.sales_division_id, ns.sales_division_id) = ?'); params.push(q.department_id); }
  if (q.sales_rep_id) { where.push('COALESCE(jo.sales_rep_id, so.sales_rep_id, ns.sales_rep_id) = ?'); params.push(q.sales_rep_id); }
  if (q.customer) { where.push('c.name LIKE ?'); params.push(`%${q.customer}%`); }
  if (q.search) {
    where.push('(jo.job_order_no LIKE ? OR jo.description LIKE ? OR c.name LIKE ? OR so.sales_order_no LIKE ? OR ns.nsso_no LIKE ?)');
    const like = `%${q.search}%`;
    params.push(like, like, like, like, like);
  }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

// Above / below the job type's passing GP rate (or approved low), as lib/commissionReport.js judges
// a passing JO. A job with no GP or no threshold (samples, internal work) cannot be rated.
function prodRating(r) {
  if (Number(r.is_approved_low_gp) === 1) return 'APPROVED LOW GP';
  if (r.gp_rate == null || r.passing_gp_rate == null) return '';
  return Number(r.gp_rate) >= Number(r.passing_gp_rate) ? 'ABOVE GP RATE' : 'BELOW GP RATE';
}

const shape = (r) => ({
  ...r,
  prod_rating: prodRating(r),
  gp_rate: r.gp_rate == null ? null : Number(r.gp_rate),
  passing_gp_rate: r.passing_gp_rate == null ? null : Number(r.passing_gp_rate),
  quantity: Number(r.quantity || 0),
  jo_amount: Number(r.jo_amount || 0),
  invoice_qty: Number(r.invoice_qty || 0),
  invoice_amount: Number(r.invoice_amount || 0),
  unbilled_qty: Number(r.quantity || 0) - Number(r.invoice_qty || 0),
});

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [locations] = await pool.query('SELECT id, location_name FROM locations ORDER BY location_name');
    const [departments] = await pool.query('SELECT id, name FROM sales_divisions ORDER BY name');
    const [reps] = await pool.query(
      `SELECT DISTINCT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name FROM employees e
         JOIN job_orders jo ON jo.sales_rep_id = e.id WHERE jo.planned_end_date IS NOT NULL ORDER BY name`);
    res.json({ locations, departments, reps, statuses: STATUSES });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = buildFilter(req.query);
    const pageNum = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));
    const [[totals]] = await pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(jo.quantity), 0) AS qty, COALESCE(SUM(COALESCE(sol.net_of_tax, nl.net_of_tax, 0)), 0) AS amount
         ${FROM_SQL} ${whereSql}`, params);
    const [rows] = await pool.query(
      `${SELECT_SQL} ${FROM_SQL} ${whereSql} ORDER BY jo.planned_end_date, jo.job_order_no LIMIT ? OFFSET ?`,
      [...params, limit, (pageNum - 1) * limit]);
    res.json({ rows: rows.map(shape), total: Number(totals.total), total_qty: Number(totals.qty), total_amount: Number(totals.amount), page: pageNum, limit });
  } catch (err) { next(err); }
});

// Download: every row under the current filters, the same columns as the screen.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = buildFilter(req.query);
    const [rows] = await pool.query(`${SELECT_SQL} ${FROM_SQL} ${whereSql} ORDER BY jo.planned_end_date, jo.job_order_no`, params);
    const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');
    const money = { numFmt: '#,##0.00' };
    const qty = { numFmt: '#,##0.00##' };
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Forecast', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Customer', key: 'customer_name', width: 34 }, { header: 'Office Location', key: 'office_location', width: 18 },
      { header: 'JO #', key: 'job_order_no', width: 18 }, { header: 'SO / NSSO #', key: 'order_no', width: 16 },
      { header: 'Job Type', key: 'job_type', width: 26 }, { header: 'Job Description', key: 'description', width: 40 },
      { header: 'JO Location', key: 'job_location', width: 18 }, { header: 'Department', key: 'department', width: 16 },
      { header: 'Sales Rep', key: 'sales_rep', width: 24 }, { header: 'JO Status', key: 'jo_status', width: 24 },
      { header: 'JO Qty', key: 'quantity', width: 10, style: qty }, { header: 'JO Amt', key: 'jo_amount', width: 14, style: money },
      { header: 'Delivery Date', key: 'delivery_date', width: 13 }, { header: 'Forecast Date', key: 'forecast_date', width: 13 },
      { header: 'AB Date', key: 'ab_date', width: 12 }, { header: 'ID Date', key: 'id_date', width: 12 },
      { header: 'Invoice Date', key: 'invoice_date', width: 13 }, { header: 'Invoice Qty', key: 'invoice_qty', width: 11, style: qty },
      { header: 'Invoice Amt', key: 'invoice_amount', width: 14, style: money }, { header: 'Unbilled Qty', key: 'unbilled_qty', width: 12, style: qty },
      { header: 'Prod Rating', key: 'prod_rating', width: 16 }, { header: 'GP %', key: 'gp_rate', width: 8 }, { header: 'Passing GP %', key: 'passing_gp_rate', width: 12 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = 'A1:W1';
    for (const r of rows.map(shape)) {
      ws.addRow({
        ...r, delivery_date: day(r.delivery_date), forecast_date: day(r.forecast_date), ab_date: day(r.ab_date),
        id_date: day(r.id_date), invoice_date: day(r.invoice_date),
      });
    }
    const label = req.query.mode === 'range' ? `${req.query.from || ''}_${req.query.to || ''}`
      : req.query.mode === 'as_of' ? `as-of-${req.query.as_of || ''}` : (req.query.month || new Date().toISOString().slice(0, 7));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="forecast-report-${label}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

module.exports = router;
