const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { sendXlsx, day } = require('../lib/xlsxExport');

// Sales > Installation Orders per Month (asked 2026-11-04): the Sales Orders, month by month, that
// carry installation work -- one row per Job Order that is an installation job, with its order.
//
// A JO counts as installation when its Job Type is one (SIGN-INSTALLATION, INSTALLATION CHARGE/
// MOBILIZATION, SIGN-BILLBOARD WITH INSTALLATION, ...) or any of its processes is one (SIGN-
// INSTALLATION, Signage - Installation - ..., Subcontracting - ... Installation ...). "Matched by"
// narrows to either. De-installation names match too: it is installation crew work.
// Orders are SOs and NSSOs (an NSSO's NSJOs are job_orders rows); the month is the order's date.
//
// GET ?month_from=YYYY-MM&month_to=YYYY-MM (default this month) -> { summary, rows, total };
// ?format=xlsx for the download (every row; the Month column groups them).
const router = express.Router();
const ROUTE = '/reports/installation-orders';

const INSTAL = "'%INSTAL%'";
// The installation processes on each JO, names joined.
const PROC = `(SELECT jop.job_order_id,
                      GROUP_CONCAT(DISTINCT p.process_name ORDER BY p.process_name SEPARATOR '; ') AS names
                 FROM job_order_processes jop JOIN processes p ON p.id = jop.process_id
                WHERE p.process_name LIKE ${INSTAL}
                GROUP BY jop.job_order_id)`;

const FROM = `
    FROM job_orders jo
    LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
    LEFT JOIN non_standard_sales_orders ns ON ns.id = jo.nsso_id
    LEFT JOIN sales_order_lines sol ON sol.id = jo.sales_order_line_id
    LEFT JOIN non_standard_sales_order_lines nsl ON nsl.id = jo.nsso_line_id
    LEFT JOIN job_types jt ON jt.id = jo.job_type_id
    LEFT JOIN ${PROC} ip ON ip.job_order_id = jo.id
    LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, ns.customer_id)
    LEFT JOIN employees sr ON sr.id = COALESCE(so.sales_rep_id, ns.sales_rep_id)
    LEFT JOIN locations jl ON jl.id = jo.job_location_id
    LEFT JOIN locations ol ON ol.id = COALESCE(so.office_location_id, ns.office_location_id)`;

const ORDER_DATE = 'COALESCE(so.date_created, ns.date_created)';
const TYPE_MATCH = `jt.display_name LIKE ${INSTAL}`;
const PROC_MATCH = 'ip.job_order_id IS NOT NULL';

const SO_STATUS_LABEL = {
  pending_for_jo: 'Pending for JO', jo_in_process: 'JO in Process', pending_delivery: 'Pending Delivery',
  pending_billing_partially_delivered: 'Pending Billing / Partially Delivered', pending_billing: 'Pending Billing',
  billed: 'Billed', cancelled: 'Cancelled',
};

const SELECT = `
  SELECT DATE_FORMAT(${ORDER_DATE}, '%Y-%m') AS month,
         so.id AS so_id, ns.id AS nsso_id, COALESCE(so.sales_order_no, ns.nsso_no) AS order_no,
         ${ORDER_DATE} AS order_date, COALESCE(so.status, ns.status) AS order_status,
         c.id AS customer_id, c.name AS customer_name,
         COALESCE(so.contract_description, ns.contract_description) AS contract_description,
         CONCAT_WS(' ', sr.first_name, sr.last_name) AS sales_rep, ol.location_name AS office_location,
         jo.id AS job_order_id, jo.job_order_no, jt.display_name AS job_type, jo.description,
         jo.quantity, jo.units, jl.location_name AS location, jo.delivery_date, jo.status AS jo_status,
         jo.sub_status AS jo_sub_status, ip.names AS installation_processes,
         (${TYPE_MATCH}) AS by_type, (${PROC_MATCH}) AS by_process,
         COALESCE(sol.net_of_tax, nsl.net_of_tax) AS net_of_tax, COALESCE(sol.gross_amount, nsl.gross_amount) AS gross_amount`;

const MONTH = /^\d{4}-\d{2}$/;
const thisMonth = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const monthLabel = (ym) => {
  const [y, m] = String(ym || '').split('-').map(Number);
  return y ? `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}` : '';
};

function buildWhere(q) {
  let from = MONTH.test(q.month_from || '') ? q.month_from : thisMonth();
  let to = MONTH.test(q.month_to || '') ? q.month_to : from;
  if (to < from) [from, to] = [to, from];
  const where = [`${ORDER_DATE} BETWEEN ? AND ?`];
  const params = [`${from}-01`, lastDay(to)];
  if (q.matched_by === 'job_type') where.push(TYPE_MATCH);
  else if (q.matched_by === 'process') where.push(PROC_MATCH);
  else where.push(`(${TYPE_MATCH} OR ${PROC_MATCH})`);
  if (q.order_type === 'so') where.push('so.id IS NOT NULL');
  else if (q.order_type === 'nsso') where.push('so.id IS NULL AND ns.id IS NOT NULL');
  else where.push('(so.id IS NOT NULL OR ns.id IS NOT NULL)');
  // Cancelled orders are left out unless asked for.
  if (q.order_status && SO_STATUS_LABEL[q.order_status]) { where.push('COALESCE(so.status, ns.status) = ?'); params.push(q.order_status); }
  else if (q.order_status !== 'all') where.push("COALESCE(so.status, ns.status, '') <> 'cancelled'");
  if (q.sales_rep_id) { where.push('COALESCE(so.sales_rep_id, ns.sales_rep_id) = ?'); params.push(q.sales_rep_id); }
  if (q.sales_division_id) { where.push('COALESCE(so.sales_division_id, ns.sales_division_id) = ?'); params.push(q.sales_division_id); }
  if (q.location_id) { where.push('jo.job_location_id = ?'); params.push(q.location_id); }
  if (q.office_location_id) { where.push('COALESCE(so.office_location_id, ns.office_location_id) = ?'); params.push(q.office_location_id); }
  if (q.search) {
    where.push(`(so.sales_order_no LIKE ? OR ns.nsso_no LIKE ? OR jo.job_order_no LIKE ? OR c.name LIKE ?
                 OR jo.description LIKE ? OR so.contract_description LIKE ? OR ns.contract_description LIKE ?)`);
    params.push(...Array(7).fill(`%${q.search}%`));
  }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params, from, to };
}

const shape = (r) => ({
  ...r,
  month_label: monthLabel(r.month),
  order_status_label: SO_STATUS_LABEL[r.order_status] || r.order_status || '',
  matched_by: [Number(r.by_type) ? 'Job Type' : '', Number(r.by_process) ? 'Process' : ''].filter(Boolean).join(' + '),
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const q = req.query;
    const { whereSql, params, from, to } = buildWhere(q);
    const order = `ORDER BY ${ORDER_DATE}, order_no, jo.job_order_no`;
    const [summary] = await pool.query(
      `SELECT DATE_FORMAT(${ORDER_DATE}, '%Y-%m') AS month,
              COUNT(DISTINCT COALESCE(CONCAT('SO', so.id), CONCAT('NS', ns.id))) AS orders,
              COUNT(*) AS job_orders,
              SUM(${TYPE_MATCH}) AS by_type, SUM(${PROC_MATCH}) AS by_process,
              SUM(COALESCE(sol.net_of_tax, nsl.net_of_tax, 0)) AS net_of_tax,
              SUM(COALESCE(sol.gross_amount, nsl.gross_amount, 0)) AS gross_amount
       ${FROM} ${whereSql} GROUP BY month ORDER BY month`, params);
    const summaryOut = summary.map((s) => ({
      ...s, month_label: monthLabel(s.month), orders: Number(s.orders), job_orders: Number(s.job_orders),
      by_type: Number(s.by_type), by_process: Number(s.by_process),
      net_of_tax: Number(s.net_of_tax), gross_amount: Number(s.gross_amount),
    }));

    if (String(q.format).toLowerCase() === 'xlsx') {
      const [rows] = await pool.query(`${SELECT} ${FROM} ${whereSql} ${order}`, params);
      return sendXlsx(res, {
        filename: `Installation-Orders-${from}${to !== from ? `-to-${to}` : ''}.xlsx`, sheet: 'Installation Orders',
        columns: [
          { header: 'Month', key: 'month_label', width: 10 },
          { header: 'SO #', key: 'order_no', width: 14 }, { header: 'SO Date', key: 'order_date', width: 12 },
          { header: 'SO Status', key: 'order_status_label', width: 18 },
          { header: 'Customer', key: 'customer_name', width: 34 }, { header: 'Contract Desc.', key: 'contract_description', width: 40 },
          { header: 'Sales Rep', key: 'sales_rep', width: 22 }, { header: 'Office Location', key: 'office_location', width: 16 },
          { header: 'JO #', key: 'job_order_no', width: 18 }, { header: 'Job Type', key: 'job_type', width: 30 },
          { header: 'Description', key: 'description', width: 44 },
          { header: 'Qty', key: 'quantity', width: 10, numFmt: '#,##0.##' }, { header: 'Units', key: 'units', width: 8 },
          { header: 'Location', key: 'location', width: 16 }, { header: 'Date Needed', key: 'delivery_date', width: 12 },
          { header: 'JO Status', key: 'jo_status', width: 14 }, { header: 'JO Sub Status', key: 'jo_sub_status', width: 18 },
          { header: 'Installation Process(es)', key: 'installation_processes', width: 50 },
          { header: 'Matched By', key: 'matched_by', width: 18 },
          { header: 'Net of Tax', key: 'net_of_tax', width: 14, money: true }, { header: 'Gross Amount', key: 'gross_amount', width: 14, money: true },
        ],
        rows: rows.map(shape).map((r) => ({
          ...r, order_date: day(r.order_date), delivery_date: day(r.delivery_date),
          quantity: r.quantity == null ? null : Number(r.quantity),
          net_of_tax: r.net_of_tax == null ? null : Number(r.net_of_tax),
          gross_amount: r.gross_amount == null ? null : Number(r.gross_amount),
        })),
      });
    }
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 25));
    const total = summaryOut.reduce((n, s) => n + s.job_orders, 0);
    const [rows] = await pool.query(`${SELECT} ${FROM} ${whereSql} ${order} LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    return res.json({ summary: summaryOut, rows: rows.map(shape), total, page, limit, month_from: from, month_to: to });
  } catch (err) { return next(err); }
});

module.exports = router;
