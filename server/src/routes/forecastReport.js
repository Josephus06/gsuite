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

// The production STATUS column of the sales template (Downloads/SALES 1.xlsx): how far the job has
// been built.
const BUILD_STATUS_SQL = `CASE
    WHEN jo.production_stage IN ('completed', 'invoiced') OR jo.quantity_built >= jo.quantity THEN 'BUILT'
    WHEN jo.quantity_built > 0 THEN 'PARTIALLY BUILT'
    WHEN jo.production_stage = 'for_qi' THEN 'FOR BUILD'
    ELSE 'IN PROGRESS' END`;

// Last build / delivery / invoice per Job Order, and what has been invoiced. Correlated, so they
// only run for the page of rows actually returned.
const SELECT_SQL = `SELECT jo.id, jo.job_order_no, jo.description, jo.quantity,
    COALESCE(so.date_created, ns.date_created) AS order_date, ${BUILD_STATUS_SQL} AS build_status,
    COALESCE(jo.delivery_date, sol.delivery_date, nl.delivery_date) AS line_delivery_date,
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

// The period the Date Forecast filter selects: a month (default -- "extract per month"), a range,
// or everything up to a date. { start, end } -- either may be null for an open-ended range.
function periodOf(q) {
  const mode = q.mode || 'month';
  if (mode === 'as_of') return { start: null, end: DATE_RE.test(String(q.as_of || '')) ? q.as_of : null };
  if (mode === 'range') return { start: DATE_RE.test(String(q.from || '')) ? q.from : null, end: DATE_RE.test(String(q.to || '')) ? q.to : null };
  const month = /^\d{4}-\d{2}$/.test(String(q.month || '')) ? q.month : new Date().toISOString().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  return { start: `${month}-01`, end: ymd(new Date(Date.UTC(y, m, 0))) };
}

// The sales template's week columns: weeks ending FRIDAY (09/25/2026 ...), the last one cut at
// the period's end (09/30/2026). Each is { start, end }, headed by its end date. A period with
// no start begins at the earliest forecast in it (`firstForecast`).
function weeksOf({ start, end }, firstForecast) {
  const from = start || firstForecast;
  if (!from || !end || from > end) return [];
  const weeks = [];
  let s = from;
  while (s <= end) {
    const dow = new Date(`${s}T00:00:00Z`).getUTCDay(); // 0 Sun .. 5 Fri
    const fri = addDays(s, (5 - dow + 7) % 7);
    const e = fri < end ? fri : end;
    weeks.push({ start: s, end: e });
    s = addDays(e, 1);
  }
  return weeks;
}

// Which week is "this week" -- the WEEKLY TARGET column -- or -1 when today is outside the period.
function currentWeekIndex(weeks) {
  const today = ymd(new Date(Date.now() + 8 * 3600 * 1000)); // business time, UTC+8
  return weeks.findIndex((w) => today >= w.start && today <= w.end);
}

function buildFilter(q) {
  const where = ['jo.planned_end_date IS NOT NULL'];
  const params = [];
  const { start, end } = periodOf(q);
  if (start) { where.push('jo.planned_end_date >= ?'); params.push(start); }
  if (end) { where.push('jo.planned_end_date <= ?'); params.push(end); }
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

const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The week columns for one row: its Net of Tax under the week its forecast falls in. WEEKLY TARGET
// is that amount when the week is this week; PENDING is it when the job falls in another week and
// is not yet fully invoiced -- what is still to come in.
function weekSplit(r, weeks, cur) {
  const fc = day(r.forecast_date);
  const wi = weeks.findIndex((w) => fc >= w.start && fc <= w.end);
  const amt = Number(r.jo_amount || 0);
  const unbilled = Number(r.quantity || 0) - Number(r.invoice_qty || 0) > 0;
  return {
    weeks: weeks.map((_, i) => (i === wi ? amt : 0)),
    weekly_target: wi >= 0 && wi === cur ? amt : 0,
    pending: !(wi >= 0 && wi === cur) && unbilled ? amt : 0,
  };
}

const shape = (r, weeks, cur) => ({
  ...r,
  prod_rating: prodRating(r),
  gp_rate: r.gp_rate == null ? null : Number(r.gp_rate),
  passing_gp_rate: r.passing_gp_rate == null ? null : Number(r.passing_gp_rate),
  quantity: Number(r.quantity || 0),
  jo_amount: Number(r.jo_amount || 0),
  // Net of Tax / Qty: the discounted price per piece, as the sales order line has it.
  unit_price: Number(r.quantity) ? round2(Number(r.jo_amount || 0) / Number(r.quantity)) : 0,
  invoice_qty: Number(r.invoice_qty || 0),
  invoice_amount: Number(r.invoice_amount || 0),
  unbilled_qty: Number(r.quantity || 0) - Number(r.invoice_qty || 0),
  ...weekSplit(r, weeks, cur),
});

// The period's weeks, and every row's forecast / amount / invoiced qty for the column totals --
// one light query over the whole filter, so the totals do not depend on the page shown.
async function weeksAndTotals(q, whereSql, params) {
  const period = periodOf(q);
  const [all] = await pool.query(
    `SELECT jo.planned_end_date AS forecast_date, jo.quantity, COALESCE(sol.net_of_tax, nl.net_of_tax, 0) AS jo_amount,
            (SELECT COALESCE(SUM(sil.quantity), 0) FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id = sil.sales_invoice_id
              WHERE sil.job_order_id = jo.id AND si.status <> 'cancelled') AS invoice_qty
       ${FROM_SQL} ${whereSql}`, params);
  const first = all.reduce((m, r) => { const d = day(r.forecast_date); return !m || d < m ? d : m; }, null);
  const last = all.reduce((m, r) => { const d = day(r.forecast_date); return !m || d > m ? d : m; }, null);
  const weeks = weeksOf({ start: period.start, end: period.end || last }, first);
  const cur = currentWeekIndex(weeks);
  const totals = { weeks: weeks.map(() => 0), weekly_target: 0, pending: 0, qty: 0, amount: 0 };
  for (const r of all) {
    const s = weekSplit(r, weeks, cur);
    s.weeks.forEach((v, i) => { totals.weeks[i] += v; });
    totals.weekly_target += s.weekly_target; totals.pending += s.pending;
    totals.qty += Number(r.quantity || 0); totals.amount += Number(r.jo_amount || 0);
  }
  totals.weeks = totals.weeks.map(round2);
  ['weekly_target', 'pending', 'amount'].forEach((k) => { totals[k] = round2(totals[k]); });
  return { weeks, cur, totals, count: all.length };
}

// Sales Rep, then newest Sales Order first -- the template's order.
const ORDER_SQL = "ORDER BY sales_rep, order_date DESC, jo.job_order_no";

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
    const { weeks, cur, totals, count } = await weeksAndTotals(req.query, whereSql, params);
    const [rows] = await pool.query(
      `${SELECT_SQL} ${FROM_SQL} ${whereSql} ${ORDER_SQL} LIMIT ? OFFSET ?`,
      [...params, limit, (pageNum - 1) * limit]);
    res.json({
      rows: rows.map((r) => shape(r, weeks, cur)), total: count, total_qty: totals.qty, total_amount: totals.amount,
      weeks: weeks.map((w) => w.end), current_week: cur, week_totals: totals.weeks,
      total_weekly_target: totals.weekly_target, total_pending: totals.pending, page: pageNum, limit,
    });
  } catch (err) { next(err); }
});

// Download, in the sales team's own workbook layout (Downloads/SALES 1.xlsx, sheet "Back-Order"):
// one row per Job Order, its Net of Tax under the Friday week its forecast falls in, then Delivery /
// Forecast Date, STATUS, WEEKLY TARGET and PENDING, and a totals row. Bold 11pt, every cell
// bordered, tall wrapped rows, no gridlines -- as the template.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = buildFilter(req.query);
    const { weeks, cur } = await weeksAndTotals(req.query, whereSql, params);
    const [raw] = await pool.query(`${SELECT_SQL} ${FROM_SQL} ${whereSql} ${ORDER_SQL}`, params);
    const rows = raw.map((r) => shape(r, weeks, cur));
    const mdy = (v) => { const s = day(v); return s ? `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}` : ''; };

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Back-Order (${rows.length})`.slice(0, 31), {
      views: [{ state: 'frozen', ySplit: 1, showGridLines: false, zoomScale: 70 }],
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    const cols = [
      { header: 'Date', width: 15.7 }, { header: 'Customer', width: 35.6 }, { header: 'JO #', width: 19 },
      { header: 'JO Status', width: 23.1 }, { header: 'Sales Rep', width: 23.3 }, { header: 'Job Type', width: 35.6 },
      { header: 'Description', width: 35.6 }, { header: 'Unit Price', width: 21.4, money: true }, { header: 'Qty', width: 11.2 },
      { header: 'Net of Tax', width: 17.1, money: true },
      ...weeks.map((w) => ({ header: mdy(w.end), width: 19.4, money: true, week: true })),
      { header: 'Delivery Date', width: 19.4 }, { header: 'Forecast Date', width: 20.4 }, { header: 'STATUS', width: 19.4 },
      { header: 'WEEKLY TARGET', width: 22.3, money: true }, { header: 'PENDING', width: 17.3, money: true },
    ];
    ws.columns = cols.map((c) => ({ width: c.width }));
    const border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    const font = { bold: true, size: 11 };

    const head = ws.getRow(1);
    cols.forEach((c, i) => {
      const cell = head.getCell(i + 1);
      cell.value = c.header; cell.font = font; cell.border = border;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    head.height = 59.4;

    rows.forEach((r, n) => {
      const values = [
        mdy(r.order_date), r.customer_name || '', r.job_order_no, r.jo_status, r.sales_rep || '', r.job_type || '',
        r.description || '', r.unit_price, r.quantity, r.jo_amount,
        ...r.weeks.map((v) => (v ? v : null)),
        mdy(r.line_delivery_date), mdy(r.forecast_date), r.build_status,
        r.weekly_target || null, r.pending || null,
      ];
      const row = ws.getRow(n + 2);
      values.forEach((v, i) => {
        const cell = row.getCell(i + 1);
        cell.value = v; cell.font = font; cell.border = border;
        const c = cols[i];
        if (c.money) cell.numFmt = '#,##0.00';
        const centered = ['Delivery Date', 'Forecast Date', 'STATUS'].includes(c.header);
        cell.alignment = { vertical: 'middle', wrapText: true, horizontal: centered ? 'center' : undefined };
      });
      row.height = 59.4;
    });

    // Totals under Net of Tax, every week, WEEKLY TARGET and PENDING -- live SUMs, as the template.
    const last = rows.length + 1;
    const total = ws.getRow(last + 1);
    cols.forEach((c, i) => {
      if (!(c.money && c.header !== 'Unit Price')) return;
      const col = ws.getColumn(i + 1).letter;
      const cell = total.getCell(i + 1);
      cell.value = rows.length ? { formula: `SUM(${col}2:${col}${last})` } : 0;
      cell.font = font; cell.numFmt = '#,##0.00'; cell.border = border;
    });
    total.height = 30;
    // This week's column, marked so the target reads at a glance.
    if (cur >= 0) {
      const wcol = 11 + cur;
      for (let r = 1; r <= last + 1; r += 1) ws.getRow(r).getCell(wcol).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
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
