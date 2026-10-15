const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { salesScope, scopeWhere } = require('../lib/salesReportScope');

// Sales > Top Customers per Year (asked 2026-10-15): the customers who ordered the most in a year,
// ranked by what they ordered -- the Net of Tax of their Sales Orders created that year, cancelled
// orders left out. The previous year's figure sits beside it so a rise or a fall shows.
//
// Whose orders count is the same rule as Weighted Sales (lib/salesReportScope.js): an account
// officer sees their own customers, a supervisor their team's, an SBU head their group's.
const router = express.Router();
const ROUTE = '/reports/top-customers';
const TOP_CHOICES = [10, 20, 50, 100];

async function buildFilter(q, userId) {
  const scope = await salesScope(userId);
  const where = ["(so.status IS NULL OR so.status <> 'cancelled')", 'so.customer_id IS NOT NULL'];
  const params = [];
  scopeWhere(scope, where, params);
  if (q.office_location_id) { where.push('so.office_location_id = ?'); params.push(Number(q.office_location_id)); }
  if (q.sales_division_id) { where.push('so.sales_division_id = ?'); params.push(Number(q.sales_division_id)); }
  if (q.sales_rep_id) { where.push('so.sales_rep_id = ?'); params.push(Number(q.sales_rep_id)); }
  return { scope, where, params };
}

const yearRange = (y) => [`${y}-01-01`, `${y + 1}-01-01`];

async function build(q, userId) {
  const year = /^\d{4}$/.test(String(q.year || '')) ? Number(q.year) : new Date().getFullYear();
  const top = TOP_CHOICES.includes(Number(q.top)) ? Number(q.top) : 20;
  const { where, params } = await buildFilter(q, userId);
  const base = where.join(' AND ');

  const [rows] = await pool.query(
    `SELECT so.customer_id, c.name AS customer_name, COUNT(*) AS orders,
            SUM(COALESCE(so.net_of_tax, 0)) AS net_of_tax, SUM(COALESCE(so.total_amount, 0)) AS gross_amount,
            MIN(so.date_created) AS first_order, MAX(so.date_created) AS last_order
       FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id
      WHERE ${base} AND so.date_created >= ? AND so.date_created < ?
      GROUP BY so.customer_id, c.name
      ORDER BY net_of_tax DESC, c.name
      LIMIT ?`,
    [...params, ...yearRange(year), top]);

  const [[all]] = await pool.query(
    `SELECT COUNT(DISTINCT so.customer_id) AS customers, COUNT(*) AS orders, SUM(COALESCE(so.net_of_tax, 0)) AS net_of_tax
       FROM sales_orders so WHERE ${base} AND so.date_created >= ? AND so.date_created < ?`,
    [...params, ...yearRange(year)]);

  // The year still running is compared with the same stretch of last year (1 Jan to today's date),
  // not the whole of it -- ten months against twelve would show nearly everyone falling.
  const today = new Date().toISOString().slice(0, 10);
  const running = Number(today.slice(0, 4)) === year;
  const prevRange = running
    ? [`${year - 1}-01-01`, new Date(Date.UTC(year - 1, Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) + 1)).toISOString().slice(0, 10)]
    : yearRange(year - 1);
  const prevBy = new Map();
  if (rows.length) {
    const [prev] = await pool.query(
      `SELECT so.customer_id, SUM(COALESCE(so.net_of_tax, 0)) AS net_of_tax
         FROM sales_orders so
        WHERE ${base} AND so.date_created >= ? AND so.date_created < ? AND so.customer_id IN (?)
        GROUP BY so.customer_id`,
      [...params, ...prevRange, rows.map((r) => r.customer_id)]);
    for (const p of prev) prevBy.set(p.customer_id, Number(p.net_of_tax));
  }

  const yearTotal = Number(all.net_of_tax) || 0;
  const out = rows.map((r, i) => {
    const net = Number(r.net_of_tax);
    const prev = prevBy.get(r.customer_id) || 0;
    return {
      rank: i + 1, customer_id: r.customer_id, customer_name: r.customer_name || '(unnamed customer)',
      orders: Number(r.orders), net_of_tax: net, gross_amount: Number(r.gross_amount),
      share_pct: yearTotal ? (net / yearTotal) * 100 : 0,
      first_order: r.first_order, last_order: r.last_order,
      prev_year_net: prev, change_pct: prev ? ((net - prev) / prev) * 100 : null,
    };
  });
  const topTotal = out.reduce((s, r) => s + r.net_of_tax, 0);
  return {
    year, top, rows: out,
    prev_label: running ? `${year - 1} (to ${today.slice(5)})` : String(year - 1),
    top_total: topTotal, top_share_pct: yearTotal ? (topTotal / yearTotal) * 100 : 0,
    year_total: yearTotal, year_customers: Number(all.customers) || 0, year_orders: Number(all.orders) || 0,
  };
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const scope = await salesScope(req.user.id);
    const where = ['1 = 1']; const params = [];
    scopeWhere(scope, where, params);
    const w = where.join(' AND ');
    const [reps] = await pool.query(
      `SELECT DISTINCT sr.id, CONCAT(sr.first_name, ' ', sr.last_name) AS name
         FROM sales_orders so JOIN employees sr ON sr.id = so.sales_rep_id WHERE ${w} ORDER BY name`, params);
    const [divisions] = await pool.query(
      `SELECT DISTINCT sd.id, sd.name FROM sales_orders so JOIN sales_divisions sd ON sd.id = so.sales_division_id
        WHERE ${w} ORDER BY sd.name`, params);
    const [offices] = await pool.query(
      `SELECT DISTINCT ol.id, ol.location_name AS name FROM sales_orders so JOIN locations ol ON ol.id = so.office_location_id
        WHERE ${w} ORDER BY ol.location_name`, params);
    const [years] = await pool.query(
      `SELECT DISTINCT YEAR(so.date_created) AS y FROM sales_orders so WHERE ${w} AND so.date_created IS NOT NULL ORDER BY y DESC`, params);
    const headOffice = offices.find((o) => /^head\s*office$/i.test(String(o.name).trim()));
    const LABEL = { all: 'All sales reps', sbu: 'Your SBU group', supervisor: 'You and your team', own: 'Your own sales orders', none: 'No sales rep is linked to your account' };
    res.json({
      reps, divisions, offices, years: years.map((r) => r.y), top_choices: TOP_CHOICES,
      default_office_location_id: headOffice ? headOffice.id : null, scope: scope.kind, scope_label: LABEL[scope.kind],
    });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try { res.json(await build(req.query, req.user.id)); } catch (err) { next(err); }
});

router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const r = await build(req.query, req.user.id);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Top ${r.top} ${r.year}`, { views: [{ state: 'frozen', ySplit: 1 }] });
    const money = { numFmt: '#,##0.00' };
    const pct = { numFmt: '0.00"%"' };
    ws.columns = [
      { header: 'Rank', key: 'rank', width: 7 }, { header: 'Customer', key: 'customer', width: 44 },
      { header: 'Sales Orders', key: 'orders', width: 13 },
      { header: `Amount Ordered ${r.year} (Net of Tax)`, key: 'net', width: 22, style: money },
      { header: 'Gross (VAT incl.)', key: 'gross', width: 18, style: money },
      { header: '% of Year', key: 'share', width: 11, style: pct },
      { header: `${r.prev_label} (Net of Tax)`, key: 'prev', width: 22, style: money },
      { header: 'Change %', key: 'change', width: 11, style: pct },
      { header: 'First Order', key: 'first', width: 12 }, { header: 'Last Order', key: 'last', width: 12 },
    ];
    const day = (v) => (v ? String(v).slice(0, 10) : '');
    for (const x of r.rows) {
      ws.addRow({
        rank: x.rank, customer: x.customer_name, orders: x.orders, net: x.net_of_tax, gross: x.gross_amount,
        share: x.share_pct, prev: x.prev_year_net, change: x.change_pct, first: day(x.first_order), last: day(x.last_order),
      });
    }
    const t = ws.addRow({ customer: `TOP ${r.top} TOTAL`, orders: r.rows.reduce((s, x) => s + x.orders, 0), net: r.top_total, share: r.top_share_pct });
    t.font = { bold: true };
    const a = ws.addRow({ customer: `ALL CUSTOMERS ${r.year} (${r.year_customers})`, orders: r.year_orders, net: r.year_total, share: r.year_total ? 100 : 0 });
    a.font = { bold: true };
    ws.getRow(1).font = { bold: true };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="top-${r.top}-customers-${r.year}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

module.exports = router;
