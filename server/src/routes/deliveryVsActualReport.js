const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

// Delivery Date Vs Actual (asked 2026-10-21) -- Production > Reports: every INVOICED Job Order, the
// delivery date promised on it against the day it was actually completed, and by how many days it
// was early or late.
//
// Only Job Orders with a (non-cancelled) Sales Invoice line count. "Completed" is the latest
// non-cancelled Quality Inspection on the JO -- the day the last of it passed QI, which is what
// completes a Job Order. An invoiced JO with no QI has no completion date and is left out.
const router = express.Router();
const ROUTE = '/reports/delivery-vs-actual';

// The completion per JO is grouped only over the JOs the period can reach (`qiScope`): grouping every
// Quality Inspection ever made took 3s a page, this takes a fraction.
const fromSql = (qiScope) => `FROM job_orders jo
  JOIN (SELECT q.job_order_id, MAX(q.date_created) AS completed_date, COUNT(*) AS qi_count
          FROM quality_inspections q WHERE q.status <> 'cancelled' ${qiScope} GROUP BY q.job_order_id) qi ON qi.job_order_id = jo.id
  LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
  LEFT JOIN non_standard_sales_orders ns ON ns.id = jo.nsso_id
  LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, ns.customer_id)
  LEFT JOIN locations ol ON ol.id = COALESCE(so.office_location_id, ns.office_location_id)
  LEFT JOIN locations jl ON jl.id = jo.job_location_id
  LEFT JOIN sales_divisions sd ON sd.id = COALESCE(so.sales_division_id, ns.sales_division_id)
  LEFT JOIN employees sr ON sr.id = COALESCE(jo.sales_rep_id, so.sales_rep_id, ns.sales_rep_id)
  LEFT JOIN job_types jt ON jt.id = jo.job_type_id`;

const INVOICED_SQL = `EXISTS (SELECT 1 FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id = sil.sales_invoice_id
    WHERE sil.job_order_id = jo.id AND si.status <> 'cancelled')`;

// Completed after the delivery date is late, before it early, the same day on time.
const VARIANCE_SQL = 'DATEDIFF(qi.completed_date, jo.delivery_date)';
const RESULT_SQL = `CASE WHEN ${VARIANCE_SQL} > 0 THEN 'LATE' WHEN ${VARIANCE_SQL} < 0 THEN 'EARLY' ELSE 'ON TIME' END`;
const RESULTS = ['EARLY', 'ON TIME', 'LATE'];

const SELECT_SQL = `SELECT jo.id, jo.job_order_no, jo.description, jo.quantity, jo.delivery_date, jo.delivery_time,
    qi.completed_date, qi.qi_count, ${VARIANCE_SQL} AS variance_days, ${RESULT_SQL} AS result,
    COALESCE(so.sales_order_no, ns.nsso_no) AS order_no, COALESCE(so.date_created, ns.date_created) AS order_date,
    c.id AS customer_id, c.name AS customer_name, ol.location_name AS office_location, jl.location_name AS job_location,
    sd.name AS department, CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep, jt.display_name AS job_type,
    (SELECT GROUP_CONCAT(DISTINCT si.invoice_no ORDER BY si.invoice_no SEPARATOR ', ')
       FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id = sil.sales_invoice_id
      WHERE sil.job_order_id = jo.id AND si.status <> 'cancelled') AS invoice_nos`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ymd = (d) => d.toISOString().slice(0, 10);

// The period: a month (default) or a range, on the completed date (default) or the delivery date.
function periodOf(q) {
  if (q.mode === 'range') return { start: DATE_RE.test(String(q.from || '')) ? q.from : null, end: DATE_RE.test(String(q.to || '')) ? q.to : null };
  const month = /^\d{4}-\d{2}$/.test(String(q.month || '')) ? q.month : new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  return { start: `${month}-01`, end: ymd(new Date(Date.UTC(y, m, 0))) };
}

function buildFilter(q) {
  const where = ["jo.status <> 'Cancelled'", 'jo.delivery_date IS NOT NULL', INVOICED_SQL];
  const params = [];
  const col = q.basis === 'delivery' ? 'jo.delivery_date' : 'qi.completed_date';
  const { start, end } = periodOf(q);
  if (start) { where.push(`${col} >= ?`); params.push(start); }
  if (end) { where.push(`${col} <= ?`); params.push(end); }
  if (RESULTS.includes(q.result)) { where.push(`${RESULT_SQL} = ?`); params.push(q.result); }
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
  // The same period, narrowing the QI grouping: JOs with a QI in it (its last is then checked
  // outside), or JOs due in it.
  const scope = [];
  const scopeParams = [];
  if (start || end) {
    const range = [start && '>= ?', end && '<= ?'].filter(Boolean);
    const sub = q.basis === 'delivery'
      ? `SELECT j2.id FROM job_orders j2 WHERE ${range.map((r) => `j2.delivery_date ${r}`).join(' AND ')}`
      : `SELECT q2.job_order_id FROM quality_inspections q2 WHERE q2.status <> 'cancelled' AND ${range.map((r) => `q2.date_created ${r}`).join(' AND ')}`;
    scope.push(`AND q.job_order_id IN (${sub})`);
    if (start) scopeParams.push(start);
    if (end) scopeParams.push(end);
  }
  return { fromSql: fromSql(scope.join(' ')), whereSql: `WHERE ${where.join(' AND ')}`, params: [...scopeParams, ...params] };
}

// Latest first by the basis date, so the newest completions lead.
const orderSql = (q) => (q.basis === 'delivery'
  ? 'ORDER BY jo.delivery_date DESC, jo.job_order_no' : 'ORDER BY qi.completed_date DESC, jo.job_order_no');

const day = (v) => (v ? String(v instanceof Date ? ymd(v) : v).slice(0, 10) : '');

async function summaryOf(fromSql, whereSql, params) {
  const [[s]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(${VARIANCE_SQL} < 0) AS early, SUM(${VARIANCE_SQL} = 0) AS on_time, SUM(${VARIANCE_SQL} > 0) AS late,
            AVG(CASE WHEN ${VARIANCE_SQL} > 0 THEN ${VARIANCE_SQL} END) AS avg_days_late,
            AVG(${VARIANCE_SQL}) AS avg_variance
       ${fromSql} ${whereSql}`, params);
  const total = Number(s.total || 0);
  const onTimeOrEarly = Number(s.early || 0) + Number(s.on_time || 0);
  return {
    total, early: Number(s.early || 0), on_time: Number(s.on_time || 0), late: Number(s.late || 0),
    // On time or early is the share delivered as promised.
    on_time_rate: total ? Math.round((onTimeOrEarly / total) * 1000) / 10 : 0,
    avg_days_late: s.avg_days_late == null ? 0 : Math.round(Number(s.avg_days_late) * 10) / 10,
    avg_variance: s.avg_variance == null ? 0 : Math.round(Number(s.avg_variance) * 10) / 10,
  };
}

const shape = (r) => ({ ...r, quantity: Number(r.quantity || 0), variance_days: Number(r.variance_days), qi_count: Number(r.qi_count || 0) });

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [locations] = await pool.query('SELECT id, location_name FROM locations ORDER BY location_name');
    const [departments] = await pool.query('SELECT id, name FROM sales_divisions ORDER BY name');
    const [reps] = await pool.query(
      `SELECT DISTINCT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name FROM employees e
         JOIN job_orders jo ON jo.sales_rep_id = e.id ORDER BY name`);
    res.json({ locations, departments, reps, results: RESULTS });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { fromSql: FROM, whereSql, params } = buildFilter(req.query);
    const pageNum = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));
    const summary = await summaryOf(FROM, whereSql, params);
    const [rows] = await pool.query(
      `${SELECT_SQL} ${FROM} ${whereSql} ${orderSql(req.query)} LIMIT ? OFFSET ?`,
      [...params, limit, (pageNum - 1) * limit]);
    res.json({ rows: rows.map(shape), summary, total: summary.total, page: pageNum, limit });
  } catch (err) { next(err); }
});

router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { fromSql: FROM, whereSql, params } = buildFilter(req.query);
    const summary = await summaryOf(FROM, whereSql, params);
    const [raw] = await pool.query(`${SELECT_SQL} ${FROM} ${whereSql} ${orderSql(req.query)}`, params);
    const rows = raw.map(shape);
    const mdy = (v) => { const s = day(v); return s ? `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}` : ''; };

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Delivery Vs Actual', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'JO #', key: 'jo', width: 18 }, { header: 'SO #', key: 'so', width: 16 },
      { header: 'Customer', key: 'customer', width: 34 }, { header: 'Description', key: 'desc', width: 34 },
      { header: 'Job Type', key: 'jt', width: 24 }, { header: 'Qty', key: 'qty', width: 9 },
      { header: 'Sales Rep', key: 'rep', width: 22 }, { header: 'Office Location', key: 'ol', width: 18 },
      { header: 'Job Location', key: 'jl', width: 18 }, { header: 'Invoice #', key: 'inv', width: 22 },
      { header: 'Delivery Date', key: 'dd', width: 14 }, { header: 'Date Completed', key: 'cd', width: 15 },
      { header: 'Days (+late / -early)', key: 'var', width: 12 }, { header: 'Result', key: 'res', width: 11 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
    const fills = { LATE: 'FFFDE2E2', EARLY: 'FFE0F2FE', 'ON TIME': 'FFDCFCE7' };
    for (const r of rows) {
      const row = ws.addRow({
        jo: r.job_order_no, so: r.order_no || '', customer: r.customer_name || '', desc: r.description || '', jt: r.job_type || '',
        qty: r.quantity, rep: r.sales_rep || '', ol: r.office_location || '', jl: r.job_location || '', inv: r.invoice_nos || '',
        dd: mdy(r.delivery_date), cd: mdy(r.completed_date), var: r.variance_days, res: r.result,
      });
      row.getCell('res').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fills[r.result] } };
    }
    ws.addRow([]);
    ws.addRow([`Total ${summary.total}`, `Early ${summary.early}`, `On Time ${summary.on_time}`, `Late ${summary.late}`,
      `On time or early ${summary.on_time_rate}%`, `Avg days late ${summary.avg_days_late}`]).font = { bold: true };

    const label = req.query.mode === 'range' ? `${req.query.from || ''}_${req.query.to || ''}` : (req.query.month || '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="delivery-vs-actual-${label}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

module.exports = router;
