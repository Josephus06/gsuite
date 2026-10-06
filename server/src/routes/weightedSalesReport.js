const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { salesScope, scopeWhere } = require('../lib/salesReportScope');

// Sales > Weighted Sales per Month (asked 2026-10-03): every Sales Order line created in a month,
// with its Net of Tax -- which is what Weighted Sales is (lib/commissionReport.js: the net of tax
// of every non-cancelled SO line, by the order's date) -- summed per sales rep, and extractable.
//
// WHO SEES WHOSE, decided here on the server, most senior role first:
//   SBU Head        -- every order in the sales divisions they own, plus their reporting tree
//   Supervisor      -- their own orders and everyone under them (the whole tree, not one level)
//   Account Officer -- their own orders only
//   anyone else     -- everything (System Admin, accounting, management)
// The same rollup the commission report uses, so a rep's total here is their Weighted Sales there.
const router = express.Router();
const ROUTE = '/reports/weighted-sales';

const FROM_SQL = `FROM sales_order_lines sol
  JOIN sales_orders so ON so.id = sol.sales_order_id
  LEFT JOIN customers c ON c.id = so.customer_id
  LEFT JOIN employees sr ON sr.id = so.sales_rep_id
  LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
  LEFT JOIN locations ol ON ol.id = so.office_location_id
  LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
  LEFT JOIN job_types jt ON jt.id = sol.job_type_id`;

// month = YYYY-MM (default this month); sales_rep_id narrows within the scope, never past it.
async function buildFilter(q, userId) {
  const scope = await salesScope(userId);
  const where = ["(so.status IS NULL OR so.status <> 'cancelled')"];
  const params = [];
  const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : new Date().toISOString().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`;
  const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  where.push('so.date_created >= ? AND so.date_created < ?'); params.push(from, to);
  scopeWhere(scope, where, params);
  if (q.sales_rep_id) { where.push('so.sales_rep_id = ?'); params.push(Number(q.sales_rep_id)); }
  // Sales group = the order's sales division (Sales - 1 ... Sales - 4, branches). Narrows within the
  // scope like the rep filter -- an SBU head picks one of their own groups, never someone else's.
  if (q.sales_division_id) { where.push('so.sales_division_id = ?'); params.push(Number(q.sales_division_id)); }
  // Office location = the order's office (asked 2026-10-03; the page opens on Head Office).
  if (q.office_location_id) { where.push('so.office_location_id = ?'); params.push(Number(q.office_location_id)); }
  if (q.search) {
    const s = `%${String(q.search).trim()}%`;
    where.push('(so.sales_order_no LIKE ? OR c.name LIKE ? OR jo.job_order_no LIKE ? OR sol.description LIKE ?)');
    params.push(s, s, s, s);
  }
  return { scope, month, whereSql: `WHERE ${where.join(' AND ')}`, params };
}

const LINE_SELECT = `SELECT sol.id, so.id AS sales_order_id, so.sales_order_no, so.date_created, c.id AS customer_id, c.name AS customer_name,
    CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep, sd.name AS division_name, ol.location_name AS office_location,
    jo.job_order_no, jt.display_name AS job_type, sol.description, sol.quantity, sol.units,
    COALESCE(sol.net_of_tax, 0) AS net_of_tax,
    COALESCE(NULLIF(sol.gp_rate, 0), so.actual_gp_rate) AS gp_rate, jt.gp_rate_head AS passing_gp_rate,
    sol.is_approved_low_gp, so.status`;

// Passing GP, as the commission report judges it: meets the job type's rate, or low-GP approved.
const passing = (r) => Number(r.is_approved_low_gp) === 1
  || (r.gp_rate != null && r.passing_gp_rate != null && Number(r.gp_rate) >= Number(r.passing_gp_rate));

async function summary(whereSql, params) {
  const [rows] = await pool.query(
    `SELECT so.sales_rep_id, CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep,
            COUNT(DISTINCT so.id) AS orders, COUNT(*) AS line_count, SUM(COALESCE(sol.net_of_tax, 0)) AS weighted_sales
       ${FROM_SQL} ${whereSql}
      GROUP BY so.sales_rep_id, sales_rep ORDER BY weighted_sales DESC`, params);
  return rows.map((r) => ({ ...r, orders: Number(r.orders), lines: Number(r.line_count), weighted_sales: Number(r.weighted_sales) }));
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const scope = await salesScope(req.user.id);
    const where = ['so.sales_rep_id IS NOT NULL']; const params = [];
    scopeWhere(scope, where, params);
    // The reps this user may pick: those with orders inside their scope.
    const [reps] = await pool.query(
      `SELECT DISTINCT sr.id, CONCAT(sr.first_name, ' ', sr.last_name) AS name
         FROM sales_orders so JOIN employees sr ON sr.id = so.sales_rep_id
        WHERE ${where.join(' AND ')} ORDER BY name`, params);
    // The sales groups this user may pick: those with orders inside their scope.
    const [divisions] = await pool.query(
      `SELECT DISTINCT sd.id, sd.name
         FROM sales_orders so JOIN sales_divisions sd ON sd.id = so.sales_division_id
        WHERE ${where.join(' AND ')} ORDER BY sd.name`, params);
    // The office locations this user may pick: those with orders inside their scope.
    const [offices] = await pool.query(
      `SELECT DISTINCT ol.id, ol.location_name AS name
         FROM sales_orders so JOIN locations ol ON ol.id = so.office_location_id
        WHERE ${where.join(' AND ')} ORDER BY ol.location_name`, params);
    const headOffice = offices.find((o) => /^head\s*office$/i.test(String(o.name).trim()));
    const LABEL = { all: 'All sales reps', sbu: 'Your SBU group', supervisor: 'You and your team', own: 'Your own sales orders', none: 'No sales rep is linked to your account' };
    res.json({ reps, divisions, offices, default_office_location_id: headOffice ? headOffice.id : null, scope: scope.kind, scope_label: LABEL[scope.kind] });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { month, whereSql, params } = await buildFilter(req.query, req.user.id);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));
    const page = Math.max(1, Number(req.query.page) || 1);
    const reps = await summary(whereSql, params);
    const total = reps.reduce((s, r) => s + r.lines, 0);
    const [rows] = await pool.query(
      `${LINE_SELECT} ${FROM_SQL} ${whereSql} ORDER BY so.date_created, so.id, sol.line_no LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]);
    res.json({
      month, total, page, limit,
      total_weighted_sales: reps.reduce((s, r) => s + r.weighted_sales, 0),
      total_orders: reps.reduce((s, r) => s + r.orders, 0),
      reps, rows: rows.map((r) => ({ ...r, passing: passing(r) })),
    });
  } catch (err) { next(err); }
});

// The month as a workbook: a Summary sheet (one row per rep) and every line behind it.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { month, whereSql, params } = await buildFilter(req.query, req.user.id);
    const reps = await summary(whereSql, params);
    const [rows] = await pool.query(`${LINE_SELECT} ${FROM_SQL} ${whereSql} ORDER BY sales_rep, so.date_created, so.id, sol.line_no`, params);

    const wb = new ExcelJS.Workbook();
    const money = { numFmt: '#,##0.00' };
    const sum = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
    sum.columns = [
      { header: 'Sales Rep', key: 'rep', width: 30 }, { header: 'Sales Orders', key: 'orders', width: 13 },
      { header: 'Lines', key: 'lines', width: 9 }, { header: 'Weighted Sales', key: 'ws', width: 18, style: money },
    ];
    for (const r of reps) sum.addRow({ rep: r.sales_rep || '(no sales rep)', orders: r.orders, lines: r.lines, ws: r.weighted_sales });
    const totalRow = sum.addRow({
      rep: `TOTAL ${month}`, orders: reps.reduce((s, r) => s + r.orders, 0),
      lines: reps.reduce((s, r) => s + r.lines, 0), ws: reps.reduce((s, r) => s + r.weighted_sales, 0),
    });
    totalRow.font = { bold: true };
    sum.getRow(1).font = { bold: true };

    const ws = wb.addWorksheet('Sales Order Lines', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'SO Date', key: 'date', width: 12 }, { header: 'SO #', key: 'so', width: 14 },
      { header: 'Customer', key: 'customer', width: 36 }, { header: 'Sales Rep', key: 'rep', width: 26 },
      { header: 'Sales Division', key: 'division', width: 16 }, { header: 'Office Location', key: 'office', width: 18 },
      { header: 'JO #', key: 'jo', width: 18 }, { header: 'Job Type', key: 'job_type', width: 26 },
      { header: 'Description', key: 'description', width: 44 }, { header: 'Qty', key: 'qty', width: 9 },
      { header: 'Unit', key: 'unit', width: 8 }, { header: 'Weighted Sales (Net of Tax)', key: 'net', width: 18, style: money },
      { header: 'GP Rate %', key: 'gp', width: 10, style: money }, { header: 'Passing GP %', key: 'pass_gp', width: 12, style: money },
      { header: 'Passing', key: 'passing', width: 9 }, { header: 'SO Status', key: 'status', width: 18 },
    ];
    const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');
    for (const r of rows) {
      ws.addRow({
        date: day(r.date_created), so: r.sales_order_no, customer: r.customer_name || '', rep: r.sales_rep || '',
        division: r.division_name || '', office: r.office_location || '', jo: r.job_order_no || '', job_type: r.job_type || '',
        description: r.description || '', qty: Number(r.quantity || 0), unit: r.units || '', net: Number(r.net_of_tax || 0),
        gp: r.gp_rate == null ? null : Number(r.gp_rate), pass_gp: r.passing_gp_rate == null ? null : Number(r.passing_gp_rate),
        passing: passing(r) ? 'Yes' : 'No', status: r.status || '',
      });
    }
    ws.autoFilter = 'A1:P1';
    ws.getRow(1).font = { bold: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="weighted-sales-${month}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

module.exports = router;
