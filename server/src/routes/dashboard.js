const express = require('express');
const pool = require('../db');
const { buildSalesBreakdown, scopedMonthSales } = require('../lib/salesBreakdown');
const { requireAuth } = require('../middleware/auth');
const { DESIGN_QUEUE_STATUS } = require('../lib/designSupervisorVisibility');
const { isPlannerUser } = require('../lib/plannerRoles');
const { businessToday } = require('../lib/crmCadence');
const { pendingBillingSummary } = require('./pendingBillingReport');
const { buildIncomeStatement } = require('../lib/reportsEngine');
// Shared with the Artist Incentive report and the Assigned JO list, so the calendar cannot
// quote a different figure for the same job than the other two do.
const {
  jobOrderIncentiveExpression, nstdjoIncentiveExpression, joIncentiveBasis, NSTDJO_INCENTIVE_BASIS,
} = require('../lib/artistIncentive');

const router = express.Router();

// Sales Orders never carry a "paid" flag or link to an invoice (there's no invoices
// table in this build) -- 'billed' is the closest real status to "paid", so that's what
// Total Paid/Unpaid below are built on.
const PAID_STATUS = 'billed';
const UNPAID_STATUSES = ['pending_for_jo', 'jo_in_process', 'pending_delivery', 'partially_delivered', 'pending_billing', 'pending_billing_partially_delivered'];

// Resolves which sales-role dashboard (if any) the requesting user should see, and the
// set of employee_ids whose data they're allowed to see. Looked up fresh from the DB on
// every request rather than trusted from the JWT, matching the pattern already used for
// the estimate-approval permission check elsewhere in this app -- a role flag or the
// supervisor_id link can change after the token was issued.
async function resolveScope(userId) {
  const [[me]] = await pool.query(
    `SELECT u.id, u.employee_id, u.account_type, u.is_account_officer, u.is_supervisor, u.is_sales_manager, u.is_design_supervisor
     FROM users u WHERE u.id = ?`,
    [userId]
  );
  if (!me) return { role: 'admin', employeeIds: [] };

  // A "System Admin" account type always gets the org-wide Admin view, even if the sales
  // role checkboxes also happen to be set on it -- those two things are independent
  // fields in the Account Type step, and Account Type is the deliberate role signal.
  if (me.account_type === 'System Admin') {
    return { role: 'admin', employeeIds: [] };
  }

  // Design Supervisor takes priority over the sales-role checks below -- it's a
  // production/design role, not a sales one, even though nothing stops both flags being
  // set on the same account in principle.
  if (me.is_design_supervisor) {
    return { role: 'design_supervisor', employeeIds: me.employee_id ? [me.employee_id] : [] };
  }

  // Artist is purely the free-text Account Type value (no dedicated boolean flag exists
  // for it, same as there's none for most non-sales roles) -- checked after Design
  // Supervisor since a Design Supervisor's own Account Type is often also "Artist".
  if (me.account_type === 'Artist') {
    return { role: 'artist', employeeIds: me.employee_id ? [me.employee_id] : [] };
  }

  if (me.is_sales_manager) {
    // Sales Manager: every sales user's data (Account Officers + Supervisors), not just
    // people directly under this one manager -- there's no manager-level tree, only the
    // one-level Supervisor -> Account Officer link.
    const [rows] = await pool.query(
      `SELECT u.id, u.display_name, u.employee_id
       FROM users u WHERE u.is_account_officer = TRUE OR u.is_supervisor = TRUE`
    );
    return { role: 'sales_manager', reps: rows, employeeIds: rows.map((r) => r.employee_id).filter(Boolean) };
  }

  if (me.is_supervisor) {
    // Supervisor: themself + every Account Officer assigned to them in user_supervisors.
    // A rep with two supervisors counts for both dashboards -- that is what a second
    // assignment means -- so the same sale appears on each of their totals.
    const [rows] = await pool.query(
      `SELECT DISTINCT u.id, u.display_name, u.employee_id
       FROM users u
       LEFT JOIN user_supervisors us ON us.user_id = u.id
       WHERE us.supervisor_id = ? OR u.id = ?`,
      [userId, userId]
    );
    return { role: 'supervisor', reps: rows, employeeIds: rows.map((r) => r.employee_id).filter(Boolean) };
  }

  if (me.is_account_officer) {
    return {
      role: 'account_officer',
      reps: [{ id: me.id, display_name: null, employee_id: me.employee_id }],
      employeeIds: me.employee_id ? [me.employee_id] : [],
    };
  }

  return { role: 'admin', employeeIds: [] };
}

function monthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  return start;
}

// Half-open [start, end) bounds for a month, as plain YYYY-MM-DD strings.
//
// Built from the local date parts rather than toISOString(): at UTC+8 a local first-of-month
// midnight serialises as the previous month's last day in UTC, which would shift every boundary
// a day earlier and put the 1st's work in the wrong month.
const pad2 = (n) => String(n).padStart(2, '0');
function monthBounds(ym) {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-based
  if (/^\d{4}-\d{2}$/.test(String(ym || ''))) {
    const [y, m] = String(ym).split('-').map(Number);
    if (m >= 1 && m <= 12) { year = y; month = m - 1; }
  }
  const startY = year; const startM = month;
  const endY = month === 11 ? year + 1 : year;
  const endM = month === 11 ? 0 : month + 1;
  return {
    month: `${startY}-${pad2(startM + 1)}`,
    start: `${startY}-${pad2(startM + 1)}-01`,
    end: `${endY}-${pad2(endM + 1)}-01`,
  };
}

// Last 6 months of sales_orders total_amount, oldest first -- feeds the stat-card
// sparklines. `employeeIds` narrows to specific reps; omit/empty for the org-wide trend.
async function salesTrend(employeeIds) {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString().slice(0, 10);
  const scoped = employeeIds && employeeIds.length;
  const placeholders = scoped ? employeeIds.map(() => '?').join(', ') : '';
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(date_created, '%Y-%m') AS ym, COALESCE(SUM(total_amount), 0) AS amount
     FROM sales_orders
     WHERE date_created >= ? ${scoped ? `AND sales_rep_id IN (${placeholders})` : ''}
     GROUP BY ym ORDER BY ym`,
    scoped ? [sixMonthsAgo, ...employeeIds] : [sixMonthsAgo]
  );
  const byMonth = Object.fromEntries(rows.map((r) => [r.ym, Number(r.amount)]));
  const out = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push(byMonth[key] || 0);
  }
  return out;
}

async function repMetrics(employeeIds) {
  if (!employeeIds.length) {
    return {
      weightedSales: { count: 0, amount: 0 },
      kpi: { winRate: 0, estimatesCreated: 0, estimatesApproved: 0 },
      paid: { count: 0, amount: 0 },
      unpaid: { count: 0, amount: 0 },
      avgDealSize: 0,
      pipeline: [],
      trend: [0, 0, 0, 0, 0, 0],
      rings: [],
    };
  }
  const placeholders = employeeIds.map(() => '?').join(', ');
  const monthStart = monthRange();

  const unpaidPlaceholders = UNPAID_STATUSES.map(() => '?').join(', ');

  // Every figure below is independent of the others, so they go to the database together
  // rather than one after another. A supervisor's dashboard calls this once per rep, so the
  // serial version paid seven round trips per rep and spent over a second doing nothing but
  // waiting -- the queries themselves are milliseconds.
  const [
    [[weighted]], [[estTotals]], [[paid]], [[unpaid]], [[allTime]], [pipeline], trend,
  ] = await Promise.all([
    // Weighted Sales: net of tax of the month's non-cancelled Sales Order lines -- as the Weighted
    // Sales report, the commission report and the breakdown card read it. It was the orders' gross
    // totals, VAT and cancelled orders included, so this card read high.
    pool.query(
      `SELECT COUNT(DISTINCT so.id) AS count, COALESCE(SUM(sol.net_of_tax), 0) AS amount
       FROM sales_order_lines sol JOIN sales_orders so ON so.id = sol.sales_order_id
       WHERE so.sales_rep_id IN (${placeholders}) AND so.date_created >= ? AND so.date_created < ?
         AND (so.status IS NULL OR so.status <> 'cancelled')`,
      [...employeeIds, monthBounds(null).start, monthBounds(null).end]
    ),
    pool.query(
      `SELECT COUNT(*) AS created, SUM(status = 'approved') AS approved
       FROM estimates WHERE sales_rep_id IN (${placeholders})`,
      employeeIds
    ),
    pool.query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount
       FROM sales_orders WHERE sales_rep_id IN (${placeholders}) AND status = ?`,
      [...employeeIds, PAID_STATUS]
    ),
    pool.query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount
       FROM sales_orders WHERE sales_rep_id IN (${placeholders}) AND status IN (${unpaidPlaceholders})`,
      [...employeeIds, ...UNPAID_STATUSES]
    ),
    pool.query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount
       FROM sales_orders WHERE sales_rep_id IN (${placeholders})`,
      employeeIds
    ),
    pool.query(
      `SELECT status, COUNT(*) AS count FROM estimates WHERE sales_rep_id IN (${placeholders}) GROUP BY status`,
      employeeIds
    ),
    salesTrend(employeeIds),
  ]);

  const created = Number(estTotals?.created || 0);
  const approved = Number(estTotals?.approved || 0);
  const winRate = created ? Number(((approved / created) * 100).toFixed(1)) : 0;
  const paidAmt = Number(paid.amount);
  const unpaidAmt = Number(unpaid.amount);
  const pipelineRows = pipeline.map((p) => ({ status: p.status, count: Number(p.count) }));
  const pipelineTotal = pipelineRows.reduce((s, p) => s + p.count, 0);
  const pipelineApproved = pipelineRows.find((p) => p.status === 'approved')?.count || 0;

  return {
    weightedSales: { count: Number(weighted.count), amount: Number(weighted.amount) },
    kpi: { winRate, estimatesCreated: created, estimatesApproved: approved },
    paid: { count: Number(paid.count), amount: paidAmt },
    unpaid: { count: Number(unpaid.count), amount: unpaidAmt },
    avgDealSize: allTime.count ? Number((allTime.amount / allTime.count).toFixed(2)) : 0,
    pipeline: pipelineRows,
    trend,
    rings: [
      { label: 'Win Rate', value: winRate, color: '#7c6fe8' },
      { label: 'Paid Ratio', value: (paidAmt + unpaidAmt) > 0 ? Math.round((paidAmt / (paidAmt + unpaidAmt)) * 100) : 0, color: '#4f8cf7' },
      { label: 'Pipeline Approved', value: pipelineTotal ? Math.round((pipelineApproved / pipelineTotal) * 100) : 0, color: '#22c39e' },
    ],
  };
}

async function adminMetrics(userId) {
  const [[activeUsers]] = await pool.query('SELECT COUNT(*) AS count FROM users WHERE is_active = TRUE');
  const [[userTotals]] = await pool.query('SELECT COUNT(*) AS total FROM users');
  const [[estRingTotals]] = await pool.query(`SELECT COUNT(*) AS total, SUM(status = 'approved') AS approved FROM estimates`);

  // The three cards under the calendar (reworked 2026-10-05). They had been all-time totals --
  // Sales Order gross with cancelled orders in, and a count of every job order line ever -- which
  // said who mattered years ago, not now.
  const today = businessToday();
  const daysBack = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

  // Top Customers: invoiced sales net of VAT over the current calendar year (1 Jan - 31 Dec; was the
  // last 12 months until 2026-10-07), each with its share of all invoiced sales in that year and
  // what it still owes on open invoices (any age).
  const salesYear = Number(today.slice(0, 4));
  const salesFrom = `${salesYear}-01-01`;
  const salesTo = `${salesYear}-12-31`;
  const [[[salesTotal]], [topCustomers]] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(net_of_tax), 0) AS amount FROM sales_invoices
                WHERE status <> 'cancelled' AND date_created BETWEEN ? AND ?`, [salesFrom, salesTo]),
    // An invoice's customer is its own customer_id or, for nearly all migrated ones (13,591 of the
    // 13,627 in the year to 2026-10-05 have none), its Sales Order's.
    pool.query(
      `SELECT c.id, c.name, top.invoice_count, top.amount, COALESCE(ar.open_ar, 0) AS open_ar
       FROM (
         SELECT COALESCE(si.customer_id, so.customer_id) AS customer_id, COUNT(*) AS invoice_count, SUM(si.net_of_tax) AS amount
         FROM sales_invoices si LEFT JOIN sales_orders so ON so.id = si.sales_order_id
         WHERE si.status <> 'cancelled' AND si.date_created BETWEEN ? AND ?
         GROUP BY COALESCE(si.customer_id, so.customer_id)
         HAVING customer_id IS NOT NULL
         ORDER BY amount DESC LIMIT 5
       ) top
       JOIN customers c ON c.id = top.customer_id
       LEFT JOIN (
         SELECT COALESCE(o.customer_id, oso.customer_id) AS customer_id, SUM(o.amount_due) AS open_ar
         FROM sales_invoices o LEFT JOIN sales_orders oso ON oso.id = o.sales_order_id
         WHERE o.status = 'saved' AND o.amount_due > 0
         GROUP BY COALESCE(o.customer_id, oso.customer_id)
       ) ar ON ar.customer_id = top.customer_id
       ORDER BY top.amount DESC`, [salesFrom, salesTo]),
  ]);

  // Trending Job Types: Weighted Sales (Sales Order lines net of tax, cancelled orders out -- the
  // rule lib/salesBreakdown.js applies) for the last 90 days, beside the 90 days before, so the
  // card says what is rising or falling rather than what is merely common.
  const [trendingJobTypes] = await pool.query(
    `SELECT jt.id, jt.display_name,
            COALESCE(SUM(CASE WHEN so.date_created > ? THEN sol.net_of_tax END), 0) AS amount,
            COALESCE(SUM(CASE WHEN so.date_created <= ? THEN sol.net_of_tax END), 0) AS prev_amount
     FROM sales_order_lines sol
     JOIN sales_orders so ON so.id = sol.sales_order_id
     JOIN job_types jt ON jt.id = sol.job_type_id
     WHERE (so.status IS NULL OR so.status <> 'cancelled') AND so.date_created > ? AND so.date_created <= ?
     GROUP BY jt.id, jt.display_name
     HAVING amount > 0
     ORDER BY amount DESC LIMIT 5`,
    [daysBack(90), daysBack(90), daysBack(180), today]
  );

  // Estimates Needing Attention: open ones raised in the last 90 days, waiting on a supervisor or
  // the customer, biggest first -- with how long each has waited and whether any line sits below
  // its job type's passing GP without an Admin/GM approval (the check the approval screen makes).
  const [attentionEstimates] = await pool.query(
    `SELECT e.id, e.estimate_no, e.status, e.created_at, c.name AS customer_name,
            DATEDIFF(?, DATE(e.created_at)) AS days_waiting,
            COALESCE(SUM(ejo.gross_amount), 0) AS total_amount,
            COALESCE(SUM(ejo.gp_amount), 0) AS gp_amount, COALESCE(SUM(ejo.net_of_tax), 0) AS net_amount,
            MAX(ejo.gp_rate < jt.gp_rate_head AND NOT COALESCE(ejo.is_approved_low_gp, 0)) AS below_gp
     FROM estimates e
     JOIN customers c ON c.id = e.customer_id
     LEFT JOIN estimate_job_orders ejo ON ejo.estimate_id = e.id
     LEFT JOIN job_types jt ON jt.id = ejo.job_type_id
     WHERE e.status IN ('pending_supervisor_approval', 'pending_customer_approval') AND e.created_at >= ?
     GROUP BY e.id, e.estimate_no, e.status, e.created_at, c.name
     ORDER BY total_amount DESC LIMIT 6`,
    [today, daysBack(90)]
  );

  const [salesByDepartment] = await pool.query(
    `SELECT d.id, d.name, COUNT(*) AS order_count, COALESCE(SUM(so.total_amount), 0) AS amount
     FROM sales_orders so
     JOIN employees e ON e.id = so.sales_rep_id
     JOIN departments d ON d.id = e.department_id
     WHERE d.name LIKE 'Sales%'
     GROUP BY d.id, d.name ORDER BY d.name`
  );

  const [[pendingApprovals]] = await pool.query(
    `SELECT COUNT(*) AS count FROM estimates WHERE status IN ('pending_supervisor_approval', 'pending_customer_approval')`
  );

  const monthStart = monthRange();
  // Weighted Sales, as everywhere else it is quoted (Sales > Weighted Sales per Month, the
  // commission report, the breakdown card below): net of tax of every non-cancelled Sales Order
  // line, by the order's date -- and for THIS viewer's scope, so an SBU head's card shows their
  // SBU and agrees with the breakdown under it. An admin's scope is everything.
  const salesThisMonth = await scopedMonthSales(userId, null);
  const [[orderPaidThisMonth]] = await pool.query(
    `SELECT COUNT(*) AS count, SUM(status = ?) AS paid FROM sales_orders WHERE date_created >= ?`,
    [PAID_STATUS, monthStart]
  );

  // estimates.total_amount is a stale/legacy column (no longer written to -- the wizard
  // now computes an estimate's total live from its job orders' gross_amount, same as
  // EstimateView does), so it's re-derived here via the same rollup instead of trusted.
  const [recentEstimates] = await pool.query(
    `SELECT e.id, e.estimate_no, e.status, e.created_at, c.name AS customer_name,
            COALESCE(jo.total, 0) AS total_amount
     FROM estimates e
     JOIN customers c ON c.id = e.customer_id
     LEFT JOIN (
       SELECT estimate_id, SUM(gross_amount) AS total FROM estimate_job_orders GROUP BY estimate_id
     ) jo ON jo.estimate_id = e.id
     ORDER BY e.created_at DESC LIMIT 6`
  );

  const trend = await salesTrend();

  return {
    activeUsers: Number(activeUsers.count),
    topCustomersYear: salesYear,
    topCustomers: topCustomers.map((c) => ({
      id: c.id, name: c.name, invoiceCount: Number(c.invoice_count), amount: Number(c.amount), openAr: Number(c.open_ar),
      share: Number(salesTotal.amount) > 0 ? Number(((Number(c.amount) / Number(salesTotal.amount)) * 100).toFixed(1)) : 0,
    })),
    trendingJobTypes: trendingJobTypes.map((j) => ({
      id: j.id, name: j.display_name, amount: Number(j.amount), prevAmount: Number(j.prev_amount),
      // null when there were no sales the 90 days before -- "new", not an infinite rise.
      change: Number(j.prev_amount) > 0 ? Number((((Number(j.amount) - Number(j.prev_amount)) / Number(j.prev_amount)) * 100).toFixed(0)) : null,
    })),
    attentionEstimates: attentionEstimates.map((r) => ({
      id: r.id, estimateNo: r.estimate_no, status: r.status, customerName: r.customer_name,
      totalAmount: Number(r.total_amount), daysWaiting: Math.max(0, Number(r.days_waiting) || 0), belowGp: !!Number(r.below_gp),
      gpRate: Number(r.net_amount) > 0 ? Number(((Number(r.gp_amount) / Number(r.net_amount)) * 100).toFixed(1)) : null,
    })),
    salesByDepartment: salesByDepartment.map((d) => ({ id: d.id, name: d.name, orderCount: Number(d.order_count), amount: Number(d.amount) })),
    pendingApprovals: Number(pendingApprovals.count),
    salesThisMonth: { count: Number(salesThisMonth.count), amount: Number(salesThisMonth.amount) },
    trend,
    recentEstimates: recentEstimates.map((r) => ({
      id: r.id, estimateNo: r.estimate_no, status: r.status, totalAmount: Number(r.total_amount || 0),
      customerName: r.customer_name, createdAt: r.created_at,
    })),
    // Read by the Org-Wide Sales Trend orb, which must not depend on which rings are shown.
    estimatesApprovedPct: estRingTotals.total ? Math.round((Number(estRingTotals.approved || 0) / estRingTotals.total) * 100) : 0,
    rings: [
      { label: 'Users Active', value: userTotals.total ? Math.round((Number(activeUsers.count) / userTotals.total) * 100) : 0, color: '#7c6fe8' },
      { label: 'Estimates Approved', value: estRingTotals.total ? Math.round((Number(estRingTotals.approved || 0) / estRingTotals.total) * 100) : 0, color: '#4f8cf7' },
      { label: 'Orders Paid', value: orderPaidThisMonth.count ? Math.round((Number(orderPaidThisMonth.paid || 0) / orderPaidThisMonth.count) * 100) : 0, color: '#22c39e' },
    ],
  };
}

// The General Manager's three rings (asked 2026-10-05), over the last 30 days:
//   Sales Index           Sales Invoices net of VAT / Vendor Bills net of VAT -- pesos of sales
//                         per peso of purchases. Shown as "3.2x"; the ring is full at 5x.
//   Gross Profit          (Revenue - Cost of Goods Sold - Cost of Services) / Revenue, from the
//                         Income Statement itself so the two can never disagree.
//   Collection Efficiency customer payments received / invoice Amount (Gross - EWT) falling due.
// A ring whose base is zero shows a dash rather than a made-up 0% or 100%.
//
// Over the LAST 30 DAYS, rolling -- not the calendar month. Month to date read 16.4x / 98% / 6% on
// Oct 5 against 2.5x / 62% / 83% for all of September: early in a month the bills and cost of sales
// are not booked yet, and collections were weighed against invoices not yet due.
const RING_INDEX_FULL = 5;
const RING_WINDOW_DAYS = 30;
async function generalManagerRings() {
  const today = businessToday();
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - (RING_WINDOW_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  const [[[si]], [[vb]], [[paid]], [[due]], is] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(net_of_tax), 0) AS amount FROM sales_invoices
                WHERE status <> 'cancelled' AND date_created BETWEEN ? AND ?`, [from, today]),
    pool.query(`SELECT COALESCE(SUM(net_of_tax), 0) AS amount FROM vendor_bills
                WHERE status NOT IN ('cancelled', 'void') AND date_created BETWEEN ? AND ?`, [from, today]),
    pool.query(`SELECT COALESCE(SUM(payment_amount), 0) AS amount FROM customer_payments
                WHERE status <> 'voided' AND date_created BETWEEN ? AND ?`, [from, today]),
    pool.query(`SELECT COALESCE(SUM(gross_amount - COALESCE(ewt_amount, 0)), 0) AS amount FROM sales_invoices
                WHERE status <> 'cancelled' AND date_due BETWEEN ? AND ?`, [from, today]),
    buildIncomeStatement(today, from),
  ]);

  const sales = Number(si.amount); const purchases = Number(vb.amount);
  const index = purchases > 0 ? sales / purchases : null;

  const subtotal = (sections, subTypes) => sections
    .filter((s) => subTypes.includes(s.sub_type)).reduce((t, s) => t + Number(s.subtotals[0] || 0), 0);
  const revenue = subtotal(is.revenue_sections, ['REVENUES']);
  const cost = subtotal(is.expense_sections, ['COST OF GOOD SOLDS', 'COST OF SERVICES']);
  const gp = revenue > 0 ? Math.round(((revenue - cost) / revenue) * 100) : null;

  const collected = Number(paid.amount); const dueAmt = Number(due.amount);
  const collection = dueAmt > 0 ? Math.round((collected / dueAmt) * 100) : null;

  const pct = (v) => (v == null ? '—' : `${v}%`);
  const peso = (n) => `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return [
    { label: 'Sales Index', value: index == null ? 0 : Math.min(100, Math.round((index / RING_INDEX_FULL) * 100)),
      display: index == null ? '—' : `${index.toFixed(1)}×`, color: '#7c6fe8',
      hint: `Last 30 days: ₱${index == null ? '—' : index.toFixed(2)} of sales per ₱1 of purchases (invoiced ${peso(sales)} / billed ${peso(purchases)}, net of VAT)` },
    { label: 'Gross Profit', value: gp == null ? 0 : Math.max(0, Math.min(100, gp)), display: pct(gp), color: '#4f8cf7',
      hint: `Last 30 days: revenue less cost of goods sold and cost of services, as a share of revenue (Income Statement)` },
    { label: 'Collection Efficiency', value: collection == null ? 0 : Math.min(100, collection), display: pct(collection), color: '#22c39e',
      hint: `Last 30 days: collected ${peso(collected)} of ${peso(dueAmt)} invoiced amount that fell due` },
  ];
}

// A JO counts as "active" on the design/artist board once it has an artist and hasn't
// gone back to Sales/production yet -- covers the initial pass and any revision round,
// deliberately excluding "For Design Supervisor" (no artist yet, that's the assignment
// queue below, not a schedule row) and anything Released/Cancelled.
const ARTIST_ACTIVE_SUB_STATUSES = ['For Artist', 'For Artist (Revision)', 'Sales Approval'];

async function scheduleRows(whereSql, params) {
  const [rows] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.description, jo.sub_status, jo.planned_start_at, jo.planned_end_at,
            jo.layout_started_at, jo.layout_ended_at, jo.artist_id,
            c.name AS customer_name, CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name,
            EXISTS(SELECT 1 FROM job_order_layout_sessions s WHERE s.job_order_id = jo.id AND s.ended_at IS NULL) AS is_running
     FROM job_orders jo
     LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
     LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, (SELECT COALESCE(nx.customer_id, ex.customer_id, sx.customer_id) FROM non_standard_sales_orders nx LEFT JOIN estimates ex ON ex.id = nx.nested_estimate_id LEFT JOIN sales_orders sx ON sx.id = nx.nested_sales_order_id WHERE nx.id = jo.nsso_id))
     LEFT JOIN employees ar ON ar.id = jo.artist_id
     ${whereSql}
     ORDER BY jo.planned_start_at IS NULL, jo.planned_start_at ASC`,
    params
  );
  return rows.map((r) => ({
    id: r.id, jobOrderNo: r.job_order_no, description: r.description, subStatus: r.sub_status,
    plannedStartAt: r.planned_start_at, plannedEndAt: r.planned_end_at,
    layoutStartedAt: r.layout_started_at, layoutEndedAt: r.layout_ended_at,
    customerName: r.customer_name, artistId: r.artist_id, artistName: r.artist_name,
    isRunning: !!r.is_running,
  }));
}

async function designSupervisorMetrics() {
  const [[pendingAssignment]] = await pool.query(
    `SELECT COUNT(*) AS count FROM job_orders WHERE status = ? AND sub_status = 'For Design Supervisor'`,
    [DESIGN_QUEUE_STATUS]
  );

  const [[notStarted]] = await pool.query(
    `SELECT COUNT(*) AS count FROM job_orders
     WHERE sub_status IN ('For Artist', 'For Artist (Revision)') AND layout_started_at IS NULL`
  );

  const [[inProgress]] = await pool.query(
    `SELECT COUNT(DISTINCT jo.id) AS count
     FROM job_orders jo JOIN job_order_layout_sessions s ON s.job_order_id = jo.id AND s.ended_at IS NULL`
  );

  const [[pendingSalesApproval]] = await pool.query(
    `SELECT COUNT(*) AS count FROM job_orders WHERE sub_status = 'Sales Approval'`
  );

  const subStatusPlaceholders = ARTIST_ACTIVE_SUB_STATUSES.map(() => '?').join(', ');
  const schedule = await scheduleRows(
    `WHERE jo.artist_id IS NOT NULL AND jo.sub_status IN (${subStatusPlaceholders})`,
    ARTIST_ACTIVE_SUB_STATUSES
  );

  const [workload] = await pool.query(
    `SELECT jo.artist_id, CONCAT(ar.first_name, ' ', ar.last_name) AS name, COUNT(*) AS count
     FROM job_orders jo JOIN employees ar ON ar.id = jo.artist_id
     WHERE jo.artist_id IS NOT NULL AND jo.sub_status IN (${subStatusPlaceholders})
     GROUP BY jo.artist_id, name ORDER BY count DESC`,
    ARTIST_ACTIVE_SUB_STATUSES
  );

  // "Overdue" here means: currently running (an open Play session) and past its own
  // Planned End -- a simpler, dashboard-level proxy for the exact
  // actualSeconds-vs-allotted comparison AssignedJobOrderRun.jsx does live for one JO at
  // a time; good enough for "which of these needs attention right now".
  const [overdue] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.planned_end_at, CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name
     FROM job_orders jo
     JOIN job_order_layout_sessions s ON s.job_order_id = jo.id AND s.ended_at IS NULL
     LEFT JOIN employees ar ON ar.id = jo.artist_id
     WHERE jo.planned_end_at IS NOT NULL AND jo.planned_end_at < NOW()
     GROUP BY jo.id, jo.job_order_no, jo.planned_end_at, ar.first_name, ar.last_name
     ORDER BY jo.planned_end_at ASC`
  );

  const notStartedCount = Number(notStarted.count);
  const inProgressCount = Number(inProgress.count);
  const pendingSalesApprovalCount = Number(pendingSalesApproval.count);
  const activeCount = notStartedCount + inProgressCount;

  return {
    pendingAssignment: Number(pendingAssignment.count),
    notStarted: notStartedCount,
    inProgress: inProgressCount,
    pendingSalesApproval: pendingSalesApprovalCount,
    schedule,
    workload: workload.map((w) => ({ artistId: w.artist_id, name: w.name, count: Number(w.count) })),
    overdue: overdue.map((o) => ({ id: o.id, jobOrderNo: o.job_order_no, plannedEndAt: o.planned_end_at, artistName: o.artist_name })),
    rings: [
      { label: 'In Progress', value: activeCount ? Math.round((inProgressCount / activeCount) * 100) : 0, color: '#7c6fe8' },
      { label: 'Sales-Ready', value: (inProgressCount + pendingSalesApprovalCount) ? Math.round((pendingSalesApprovalCount / (inProgressCount + pendingSalesApprovalCount)) * 100) : 0, color: '#4f8cf7' },
    ],
  };
}

// This month's artist incentive, by the same rules as Reports > Artist Incentive, so the
// dashboard figure and the payout sheet can never disagree:
//   Job Order      -- a flat 7.50 per unit of layout work (7.50 x layout_qty), earned when the
//                     artist stops the timer (layout_ended_at).
//   Non-Standard JO -- the incentive stored per materials line when the order was saved, and only
//                     once Sales have signed it off (status COMPLETED).
// Both are dated by when the layout actually finished, not when the order was raised.
const JO_INCENTIVE_AMOUNT = 7.5;
const NSTDJO_COMPLETED_STATUS = 'COMPLETED';
// A Non-Standard Job Order holds this status for its whole design stage -- it is sub_status
// that advances through it -- so "still in the artist's hands" is this status plus
// sub_status 'For Artist'.
const NSTDJO_ACTIVE_STATUS = 'Planned - Pending for BOM';

async function artistIncentiveForMonth(employeeId, monthStart, monthEnd) {
  // Two rules, both shared with the Artist Incentive report so the dashboard figure and the
  // report can never disagree about what an artist has earned:
  //
  //  - Credited to the month the work actually FINISHED (layout_ended_at), not the month it
  //    was planned for. A job planned for the 18th and finished on the 19th belongs to the
  //    19th, and one finished across a month boundary belongs to the later month.
  //  - Only once Sales have signed it off: sub_status 'Approved' for a Job Order, status
  //    COMPLETED for a Non-Standard one. Without this the dashboard paid out the moment the
  //    artist stopped their timer, while the report -- correctly -- did not, so the two
  //    quoted different totals for the same month.
  const [[jo]] = await pool.query(
    `SELECT COALESCE(SUM(${jobOrderIncentiveExpression('jo')}), 0) AS amount,
            COUNT(*) AS jobs
       FROM job_orders jo
      WHERE jo.artist_id = ? AND jo.sub_status = 'Approved'
        AND jo.layout_ended_at >= ? AND jo.layout_ended_at < ?`,
    [employeeId, monthStart, monthEnd]
  );

  // The NSTDJO tables are not present in every build -- fall back to the Job Order side alone
  // rather than failing the whole dashboard.
  let nstd = { amount: 0, jobs: 0 };
  const [tbl] = await pool.query("SHOW TABLES LIKE 'non_standard_job_orders'");
  if (tbl.length) {
    const [[row]] = await pool.query(
      `SELECT COALESCE(SUM(${nstdjoIncentiveExpression('n')}), 0) AS amount,
              COUNT(*) AS jobs
         FROM non_standard_job_orders n
        WHERE n.artist_employee_id = ? AND n.status = ?
          AND n.layout_ended_at >= ? AND n.layout_ended_at < ?`,
      [employeeId, NSTDJO_COMPLETED_STATUS, monthStart, monthEnd]
    );
    nstd = { amount: Number(row.amount || 0), jobs: Number(row.jobs || 0) };
  }

  return {
    amount: Number((Number(jo.amount || 0) + nstd.amount).toFixed(2)),
    jobs: Number(jo.jobs || 0) + nstd.jobs,
  };
}

// The artist's scheduled work for one month, as day -> job orders, for the dashboard calendar.
// A job order lands on its planned start date; one with no planned start has nothing to sit on
// and is returned separately so it is not silently dropped from the month.
//
// Covers both Job Orders and Non-Standard Job Orders: an artist's month is whatever they were
// scheduled for, and a calendar showing only half of it misrepresents their workload. Each row
// carries `kind` so the client can send a click to the right run screen -- the two have separate
// timer endpoints and separate routes.
async function artistCalendar(employeeId, monthStart, monthEnd) {
  const [rows] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.description, jo.sub_status,
            jo.planned_start_at, jo.planned_end_at,
            jo.layout_started_at, jo.layout_ended_at,
            c.name AS customer_name,
            -- Same expressions the Artist Incentive report and the Assigned JO list use, so a
            -- day's popup cannot quote a different figure from the other two.
            ${jobOrderIncentiveExpression('jo')} AS incentive_amount,
            ${joIncentiveBasis('jo')} AS incentive_basis,
            EXISTS(SELECT 1 FROM job_order_layout_sessions s
                    WHERE s.job_order_id = jo.id AND s.ended_at IS NULL) AS is_running
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, (SELECT COALESCE(nx.customer_id, ex.customer_id, sx.customer_id) FROM non_standard_sales_orders nx LEFT JOIN estimates ex ON ex.id = nx.nested_estimate_id LEFT JOIN sales_orders sx ON sx.id = nx.nested_sales_order_id WHERE nx.id = jo.nsso_id))
      WHERE jo.artist_id = ?
        AND jo.planned_start_at >= ? AND jo.planned_start_at < ?
      ORDER BY jo.planned_start_at`,
    [employeeId, monthStart, monthEnd]
  );

  // Same guard artistIncentiveForMonth uses -- the NSTDJO tables are not present in every
  // build, and a missing table must degrade to a Job-Orders-only calendar rather than take
  // the whole dashboard down.
  let nstdjoRows = [];
  const [tbl] = await pool.query("SHOW TABLES LIKE 'non_standard_job_orders'");
  if (tbl.length) {
    [nstdjoRows] = await pool.query(
      `SELECT n.id, n.nstdjo_no AS job_order_no, n.description, n.sub_status,
              n.planned_start_at, n.planned_end_at,
              n.layout_started_at, n.layout_ended_at,
              c.name AS customer_name,
              ${nstdjoIncentiveExpression('n')} AS incentive_amount,
              '${NSTDJO_INCENTIVE_BASIS}' AS incentive_basis,
              EXISTS(SELECT 1 FROM non_standard_job_order_layout_sessions s
                      WHERE s.non_standard_job_order_id = n.id AND s.ended_at IS NULL) AS is_running
         FROM non_standard_job_orders n
         LEFT JOIN customers c ON c.id = n.customer_id
        WHERE n.artist_employee_id = ?
          AND n.planned_start_at >= ? AND n.planned_start_at < ?
        ORDER BY n.planned_start_at`,
      [employeeId, monthStart, monthEnd]
    );
  }

  const shape = (kind) => (r) => ({
    id: r.id,
    kind,
    jobOrderNo: r.job_order_no,
    description: r.description,
    subStatus: r.sub_status,
    customerName: r.customer_name,
    plannedStartAt: r.planned_start_at,
    plannedEndAt: r.planned_end_at,
    // The calendar colours a day by what is on it, so it needs to know what state each job is in.
    incentiveAmount: Number(r.incentive_amount || 0),
    incentiveBasis: r.incentive_basis,
    // When the artist actually stopped the clock, which is regularly not the planned day --
    // and is the date the incentive is credited against.
    actualEndAt: r.layout_ended_at,
    done: !!r.layout_ended_at,
    running: !!Number(r.is_running),
    startedAt: r.layout_started_at,
    day: r.planned_start_at ? String(r.planned_start_at).slice(0, 10) : null,
  });

  // Re-sorted across both sources so a day's chips read in the order the artist is meant to
  // work them, rather than all the JOs and then all the NSTDJOs.
  return [...rows.map(shape('JO')), ...nstdjoRows.map(shape('NSTDJO'))]
    .sort((a, b) => new Date(a.plannedStartAt) - new Date(b.plannedStartAt));
}

async function artistMetrics(employeeId) {
  if (!employeeId) {
    return {
      active: 0, activeJo: 0, activeNstdjo: 0, notStarted: 0, completedThisMonth: 0, avgPerformance: null,
      incentiveThisMonth: 0, incentiveJobs: 0, calendar: [], calendarMonth: null,
      schedule: [], rings: [],
    };
  }

  const [[active]] = await pool.query(
    `SELECT COUNT(*) AS count FROM job_orders WHERE artist_id = ? AND sub_status IN ('For Artist', 'For Artist (Revision)')`,
    [employeeId]
  );
  const [[notStarted]] = await pool.query(
    `SELECT COUNT(*) AS count FROM job_orders
     WHERE artist_id = ? AND sub_status IN ('For Artist', 'For Artist (Revision)') AND layout_started_at IS NULL`,
    [employeeId]
  );

  // The artist's active Non-Standard Job Orders, on exactly the terms the Assigned JO
  // worklist uses (server/src/routes/assignedJobOrders.js) so this count and that list can
  // never disagree: still in the artist's hands, not yet handed to Sales. Guarded like the
  // incentive figure -- not every build has these tables.
  let activeNstdjo = 0;
  let notStartedNstdjo = 0;
  const [nstdjoTbl] = await pool.query("SHOW TABLES LIKE 'non_standard_job_orders'");
  if (nstdjoTbl.length) {
    const [[n]] = await pool.query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(layout_started_at IS NULL), 0) AS not_started
         FROM non_standard_job_orders
        WHERE artist_employee_id = ? AND status = ?
          AND sub_status IN ('For Artist', 'For Artist (Revision)')`,
      [employeeId, NSTDJO_ACTIVE_STATUS]
    );
    activeNstdjo = Number(n.count || 0);
    notStartedNstdjo = Number(n.not_started || 0);
  }
  const monthStart = monthRange();
  const [[completedThisMonth]] = await pool.query(
    `SELECT COUNT(*) AS count FROM job_orders WHERE artist_id = ? AND layout_ended_at >= ?`,
    [employeeId, monthStart]
  );

  // Performance % per completed JO this month = allotted (minutes_consume x layout_qty)
  // / actual (sum of that JO's session durations) x 100 -- same formula
  // AssignedJobOrderRun.jsx computes live for one JO; averaged here across all of this
  // artist's completions this month for a single at-a-glance number.
  const [completedRows] = await pool.query(
    `SELECT jo.id, jo.layout_qty, pjt.minutes_consume,
            (SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, s.started_at, s.ended_at)), 0)
             FROM job_order_layout_sessions s WHERE s.job_order_id = jo.id AND s.ended_at IS NOT NULL) AS actual_seconds
     FROM job_orders jo
     LEFT JOIN pms_job_types pjt ON pjt.id = jo.layout_job_type_id
     WHERE jo.artist_id = ? AND jo.layout_ended_at >= ?`,
    [employeeId, monthStart]
  );
  const performances = completedRows
    .map((r) => {
      const allotted = Number(r.minutes_consume || 0) * Number(r.layout_qty || 1) * 60;
      const actual = Number(r.actual_seconds || 0);
      return allotted > 0 && actual > 0 ? (allotted / actual) * 100 : null;
    })
    .filter((p) => p !== null);
  const avgPerformance = performances.length
    ? Number((performances.reduce((s, p) => s + p, 0) / performances.length).toFixed(1))
    : null;

  const schedule = await scheduleRows(
    `WHERE jo.artist_id = ? AND jo.sub_status IN ('For Artist', 'For Artist (Revision)')`,
    [employeeId]
  );

  // Both totals span the two document types, so the Started Ratio ring stays coherent with
  // the Active card above it rather than measuring a different population.
  const activeJoCount = Number(active.count);
  const activeCount = activeJoCount + activeNstdjo;
  const notStartedCount = Number(notStarted.count) + notStartedNstdjo;

  // The dashboard opens on the current month; the calendar can be paged from the client via
  // GET /dashboard/artist-calendar without refetching everything else.
  const bounds = monthBounds(null);
  const incentive = await artistIncentiveForMonth(employeeId, bounds.start, bounds.end);
  const calendar = await artistCalendar(employeeId, bounds.start, bounds.end);

  return {
    active: activeCount,
    activeJo: activeJoCount,
    activeNstdjo,
    notStarted: notStartedCount,
    completedThisMonth: Number(completedThisMonth.count),
    avgPerformance,
    incentiveThisMonth: incentive.amount,
    incentiveJobs: incentive.jobs,
    calendar,
    calendarMonth: bounds.month,
    schedule,
    rings: [
      ...(avgPerformance !== null ? [{ label: 'Avg Performance', value: Math.max(0, Math.min(100, Math.round(avgPerformance))), color: '#7c6fe8' }] : []),
      { label: 'Started Ratio', value: activeCount ? Math.round(((activeCount - notStartedCount) / activeCount) * 100) : 0, color: '#4f8cf7' },
    ],
  };
}

// Which production department builds a job, derived from its job location. The four lines
// each own a warehouse ('Warehouse - CNC', 'Warehouse - DPOD', 'Warehouse - LFP',
// 'Warehouse - Sign'), and that location is what the Job Order actually carries.
//
// Matched loosely on purpose. The same department is punctuated inconsistently across the
// live data -- 'Production -  CNC' carries a double space where 'Production - CNC' does not
// (see db/add-department-job-location.js) -- so anything anchored on an exact string would
// silently drop a whole line's work off the calendar. A job whose location is none of the
// four (Central, Design, or unset) is grouped as Other rather than hidden: an invisible job
// order is the one failure mode a calendar must not have.
const DIVISIONS = [
  { key: 'CNC', match: /CNC/i },
  { key: 'DPOD', match: /DPOD/i },
  { key: 'LFP', match: /LFP/i },
  { key: 'Sign', match: /SIGN/i },
];
function divisionOf(locationName) {
  const name = String(locationName || '');
  return DIVISIONS.find((d) => d.match.test(name))?.key || 'Other';
}

// The sales dashboard's calendar: every Job Order Production has committed to build, across
// the whole shop, split by the department that will build it.
//
// FIRST, what is on it. Only Job Orders Production has ACKNOWLEDGED -- production_stage past
// 'pending_for_scheduling' and past 'for_revision', which is the same job handed back to Sales
// and not yet accepted. Acknowledge is the moment a scheduler signs up to the forecast (see
// production.js), so it is the first moment a rep has something real to promise a customer.
//
// Non-standard job orders are deliberately NOT here any more. They never enter the production
// module -- the table has no production_stage and no forecast columns -- so there is no
// acknowledgement to wait for and no forecast to sit on, and carrying them meant this calendar
// answered two different questions at once. NSTDJO work is followed from its own list.
//
// SECOND, the dates. A job sits on its FORECAST window, planned_start_date ->
// planned_end_date: the days Production committed to building it, not the layout schedule and
// not a delivery date nobody has accepted. Both are guaranteed present, because Acknowledge
// refuses to run without them. The window is sent as a span rather than one row per day -- a
// three-week job would otherwise be sent twenty times over -- and the client walks it.
//
// THIRD, the scope: THERE IS NONE, and that is the point. A rep needs the whole floor to know
// whether the date they are about to quote is realistic -- their own three jobs say nothing
// about a CNC line already booked solid with somebody else s work. The route still requires a
// sales-dashboard role to reach this; what changed is that the rows are no longer filtered to
// the caller s own sales_rep_id.
async function salesCalendar(monthStart, monthEnd) {
  const [rows] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.description, jo.status, jo.sub_status,
            jo.production_stage,
            jo.delivery_date, jo.planned_start_at, jo.planned_end_at,
            jo.planned_start_date, jo.planned_end_date,
            jo.layout_started_at, jo.layout_ended_at,
            c.name AS customer_name,
            CONCAT(a.first_name, ' ', a.last_name) AS artist_name,
            CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
            loc.location_name AS job_location_name,
            (SELECT COUNT(*) FROM job_order_layout_sessions s
              WHERE s.job_order_id = jo.id AND s.ended_at IS NULL) AS is_running
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, (SELECT COALESCE(nx.customer_id, ex.customer_id, sx.customer_id) FROM non_standard_sales_orders nx LEFT JOIN estimates ex ON ex.id = nx.nested_estimate_id LEFT JOIN sales_orders sx ON sx.id = nx.nested_sales_order_id WHERE nx.id = jo.nsso_id))
       LEFT JOIN employees a ON a.id = jo.artist_id
       LEFT JOIN employees sr ON sr.id = COALESCE(jo.sales_rep_id, so.sales_rep_id)
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
      WHERE jo.production_stage IS NOT NULL
        AND jo.production_stage NOT IN ('pending_for_scheduling', 'for_revision')
        AND jo.status <> 'Cancelled'
        AND jo.planned_start_date IS NOT NULL
        AND jo.planned_end_date IS NOT NULL
        -- Overlap, not containment: a forecast running across the month boundary belongs on
        -- this month for the days it actually occupies.
        AND jo.planned_start_date < ?
        AND jo.planned_end_date >= ?
      ORDER BY jo.planned_start_date, jo.job_order_no`,
    [monthEnd, monthStart],
  );

  const day = (v) => (v ? String(v).slice(0, 10) : null);
  return rows.map((r) => ({
    id: r.id,
    kind: 'JO',
    jobOrderNo: r.job_order_no,
    description: r.description,
    status: r.status,
    subStatus: r.sub_status,
    customerName: r.customer_name,
    artistName: r.artist_name,
    // Whose order it is. It is no longer necessarily the viewer s, so the calendar has to say.
    salesRepName: r.sales_rep_name,
    // The department that will build it, and the short key the calendar colours by.
    jobLocationName: r.job_location_name,
    division: divisionOf(r.job_location_name),
    deliveryDate: r.delivery_date,
    plannedStartAt: r.planned_start_at,
    plannedEndAt: r.planned_end_at,
    forecastStart: day(r.planned_start_date),
    forecastEnd: day(r.planned_end_date),
    productionStage: r.production_stage,
    anchor: 'forecast',
    actualEndAt: r.layout_ended_at,
    done: !!r.layout_ended_at,
    running: !!Number(r.is_running),
    startedAt: r.layout_started_at,
    // Sliced off the string rather than parsed into a Date: at UTC+8 a DATE column read back
    // through new Date() lands at 08:00 and can format onto the previous day.
    day: day(r.planned_start_date),
    // The days this job occupies. Inclusive at both ends.
    spanStart: day(r.planned_start_date),
    spanEnd: day(r.planned_end_date),
  }));
}

// The General Manager's four headline cards, in place of the admin row (the rest of the admin
// dashboard is unchanged for them). A General Manager is whoever is in general_managers -- the
// same list the ticket "forward to GM" step uses.
//
// Each figure is chosen around a known data defect, so read the notes before "simplifying":
//
//   Pending Billing   net amount of COMPLETED job orders (production_stage 'completed' -- the
//                     stage between in_process and invoiced) with no live invoice line, on sales
//                     orders not yet billed or cancelled. Work still in production is not billable
//                     yet, so it does not count. The sales-order condition matters too: migrated
//                     invoices mostly do not link back to their job orders, and without it tens of
//                     thousands of long-billed JOs look unbilled (~PHP 347M).
//   Weighted Sales    net of tax of this month's sales orders, cancelled excluded.
//   Pending Ticket    tickets forwarded to the GM and neither approved nor declined -- the same
//   Approval          test Tickets.jsx uses for "pending GM".
//   Actual Collection this month's Head Office customer payments, voided excluded, and EXCLUDING
//   Head Office       the synthetic CPAY-INV-* payments. Those were rebuilt from invoices during
//                     the migration and book the same cash as the real PAY-* receipts, so
//                     counting both roughly doubles the figure. In-app payments (CPAY-<id>) count.
//
// "This month" is the Philippine month (lib/crmCadence.js): the droplet runs UTC, where the first
// eight hours of the 1st still belong to the previous month.
async function isGeneralManager(userId) {
  const [[row]] = await pool.query('SELECT 1 AS x FROM general_managers WHERE user_id = ?', [userId]);
  return !!row;
}

async function generalManagerCards() {
  const today = businessToday();
  const monthStart = `${today.slice(0, 7)}-01`;
  // Pending Billing is the Sales > Pending Billing report's own figure, all offices and reps.
  const [billing, [[sales]], [[tickets]], [[collection]]] = await Promise.all([
    pendingBillingSummary(),
    pool.query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(net_of_tax), 0) AS amount
         FROM sales_orders WHERE date_created >= ? AND status <> 'cancelled'`, [monthStart],
    ),
    pool.query(
      `SELECT COUNT(*) AS count FROM tickets
        WHERE forwarded_to_gm_at IS NOT NULL AND gm_approved_at IS NULL AND declined_at IS NULL`,
    ),
    // No location counts as Head Office, as lib/userLocation.js isHeadOfficeName decides.
    pool.query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(cp.payment_amount), 0) AS amount
         FROM customer_payments cp
         LEFT JOIN locations l ON l.id = cp.office_location_id
        WHERE cp.date_created >= ? AND cp.voided_at IS NULL
          AND cp.customer_payment_no NOT LIKE 'CPAY-INV-%'
          AND (l.id IS NULL OR LOWER(TRIM(l.location_name)) LIKE 'head office%')`, [monthStart],
    ),
  ]);
  return {
    pendingBilling: { count: Number(billing.count), amount: Number(billing.amount) },
    weightedSales: { count: Number(sales.count), amount: Number(sales.amount) },
    pendingTicketApproval: Number(tickets.count),
    headOfficeCollection: { count: Number(collection.count), amount: Number(collection.amount) },
  };
}

// The General Manager's calendar switch: one month of Weighted Sales (sales orders by date
// created, net of tax, cancelled left out -- the same rows as the Weighted Sales card) or of
// Invoices (by date created, cancelled left out), grouped by day and then customer. An invoice is
// counted at its gross amount -- what was billed -- not amount_due, which is what is still unpaid
// and reads 0 on most of a month's invoices. Its customer is resolved through its source document
// the way the Invoices list does it, since sales_invoices.customer_id is mostly empty.
// Production and Collection Forecast have endpoints of their own.
const GM_CALENDARS = {
  sales: `SELECT so.id, so.sales_order_no AS doc_no, DATE_FORMAT(so.date_created, '%Y-%m-%d') AS day,
                 so.customer_id, c.name AS customer_name, COALESCE(so.net_of_tax, 0) AS amount
            FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id
           WHERE so.date_created >= ? AND so.date_created < ? AND so.status <> 'cancelled'`,
  invoices: `SELECT si.id, si.invoice_no AS doc_no, DATE_FORMAT(si.date_created, '%Y-%m-%d') AS day,
                    c.id AS customer_id, c.name AS customer_name, COALESCE(si.gross_amount, 0) AS amount
               FROM sales_invoices si
               LEFT JOIN sales_orders so ON so.id = si.sales_order_id
               LEFT JOIN estimates e ON e.id = si.estimate_id
               LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
               LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, e.customer_id, ns.customer_id, si.customer_id)
               LEFT JOIN delivery_tickets dt ON dt.id = si.delivery_ticket_id
              WHERE si.date_created >= ? AND si.date_created < ? AND si.cancelled_at IS NULL
                -- An invoice converted from a Delivery Ticket is never counted: the ticket itself is,
                -- on the day it was raised (GM_DT_SQL), so counting its invoice too would double it.
                AND si.delivery_ticket_id IS NULL`,
};
// Params for each calendar's SQL, from the month's bounds.
const GM_CALENDAR_PARAMS = {
  sales: (b) => [b.start, b.end],
  invoices: (b) => [b.start, b.end],
};

// The month's Delivery Tickets on the Invoice calendar, open or converted, COUNTED at their gross on
// the day each was raised (asked 2026-10-05) -- orange while open, blue once converted. The invoice a
// ticket becomes is left out of the invoices query instead, so the sale is counted once, in the
// ticket's month: a September ticket invoiced in October stays in September and adds nothing to October.
const GM_DT_SQL = `SELECT dt.id, dt.dt_no AS doc_no, DATE_FORMAT(dt.date_created, '%Y-%m-%d') AS day, dt.status,
                          c.id AS customer_id, c.name AS customer_name, COALESCE(dt.gross_amount, 0) AS amount
                     FROM delivery_tickets dt
                     LEFT JOIN sales_orders so ON so.id = dt.sales_order_id
                     LEFT JOIN customers c ON c.id = so.customer_id
                    WHERE dt.date_created >= ? AND dt.date_created < ? AND dt.status IN ('open', 'converted')
                    ORDER BY day, dt.dt_no`;

// Rows -> { day -> { count, total, customers: [{ customerName, count, total, docs }] } }.
function groupByDayAndCustomer(rows) {
  const days = new Map();
  for (const r of rows) {
    if (!days.has(r.day)) days.set(r.day, { count: 0, total: 0, customers: new Map() });
    const d = days.get(r.day);
    const key = r.customer_id || 0;
    if (!d.customers.has(key)) {
      d.customers.set(key, { customerId: key, customerName: r.customer_name || '—', count: 0, total: 0, docs: [] });
    }
    const c = d.customers.get(key);
    const amount = Number(r.amount);
    c.docs.push({ id: r.id, docNo: r.doc_no, amount, kind: r.kind || null, status: r.status || null });
    c.count += 1; c.total += amount;
    d.count += 1; d.total += amount;
  }
  for (const d of days.values()) d.customers = [...d.customers.values()].sort((a, b) => b.total - a.total);
  return days;
}

router.get('/gm-calendar', requireAuth, async (req, res, next) => {
  try {
    if (!(await isGeneralManager(req.user.id))) return res.status(403).json({ error: 'General Manager only.' });
    const sql = GM_CALENDARS[req.query.type];
    if (!sql) return res.status(400).json({ error: 'type must be sales or invoices' });
    const bounds = monthBounds(req.query.month);
    // The Invoice calendar counts the month's Delivery Tickets alongside its invoices -- see GM_DT_SQL.
    const withDts = req.query.type === 'invoices';
    // Weighted Sales: Location (the order's office location) and Department (its sales division)
    // filters (asked 2026-10-09). Blank means all.
    let extraSql = '';
    const extraParams = [];
    if (req.query.type === 'sales') {
      if (Number(req.query.location_id) > 0) { extraSql += ' AND so.office_location_id = ?'; extraParams.push(Number(req.query.location_id)); }
      if (Number(req.query.sales_division_id) > 0) { extraSql += ' AND so.sales_division_id = ?'; extraParams.push(Number(req.query.sales_division_id)); }
    }
    const [[invRows], [dtRows]] = await Promise.all([
      pool.query(`${sql}${extraSql} ORDER BY day, customer_name, doc_no`, [...GM_CALENDAR_PARAMS[req.query.type](bounds), ...extraParams]),
      withDts ? pool.query(GM_DT_SQL, [bounds.start, bounds.end]) : [[]],
    ]);
    const rows = [
      ...invRows.map((r) => ({ ...r, kind: withDts ? 'invoice' : null })),
      ...dtRows.map((r) => ({ ...r, kind: 'dt' })),
    ];

    const docs = groupByDayAndCustomer(rows);
    const calendar = [...docs.keys()].sort().map((day) => {
      const d = docs.get(day);
      return {
        day, count: d.count, total: d.total, customers: d.customers,
        // The day's tickets again, flat, for the coloured DT chips on the calendar.
        dts: dtRows.filter((r) => r.day === day).map((r) => ({
          id: r.id, docNo: r.doc_no, status: r.status, customerName: r.customer_name || '—', amount: Number(r.amount),
        })),
      };
    });
    res.json({
      month: bounds.month,
      calendar,
      count: rows.length,
      total: rows.reduce((s, r) => s + Number(r.amount), 0),
    });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user.id);

    if (scope.role === 'admin') {
      const [metrics, gm] = await Promise.all([adminMetrics(req.user.id), isGeneralManager(req.user.id)]);
      const [gmCards, gmRings] = gm ? await Promise.all([generalManagerCards(), generalManagerRings()]) : [null, null];
      return res.json({ role: 'admin', ...metrics, ...(gmRings ? { rings: gmRings } : {}), gmCards });
    }

    if (scope.role === 'design_supervisor') {
      const metrics = await designSupervisorMetrics();
      return res.json({ role: 'design_supervisor', ...metrics });
    }

    if (scope.role === 'artist') {
      const metrics = await artistMetrics(scope.employeeIds[0]);
      return res.json({ role: 'artist', ...metrics });
    }

    const summary = await repMetrics(scope.employeeIds);
    // The headline card is the viewer's whole scope (a supervisor's full reporting tree), the same
    // figure as the breakdown card's total below it.
    summary.weightedSales = await scopedMonthSales(req.user.id, null);

    let byRep = [];
    if (scope.role !== 'account_officer') {
      byRep = await Promise.all(scope.reps.map(async (r) => ({
        userId: r.id,
        name: r.display_name,
        ...(await repMetrics(r.employee_id ? [r.employee_id] : [])),
      })));
    }

    // The dashboard opens on the current month; the calendar pages from the client via
    // GET /dashboard/sales-calendar without refetching every figure on the screen.
    const bounds = monthBounds(null);
    const calendar = await salesCalendar(bounds.start, bounds.end);

    res.json({ role: scope.role, summary, byRep, calendar, calendarMonth: bounds.month });
  } catch (err) {
    next(err);
  }
});

// Lets the artist dashboard's calendar page to another month without refetching the whole
// dashboard. Scoped to the caller's own employee record -- an artist only ever sees their own
// schedule, and there is no artist_id parameter to point somewhere else.
// The sales breakdown card: one month's Weighted Sales by SBU -> sales group -> supervisor (with
// their team) -> rep. Who sees which part is lib/salesReportScope.js -- the same rule as
// Sales > Weighted Sales per Month -- so it needs no permission of its own beyond being logged in.
router.get('/sales-breakdown', requireAuth, async (req, res, next) => {
  try {
    res.json(await buildSalesBreakdown(req.user.id, req.query.month));
  } catch (err) { next(err); }
});

router.get('/artist-calendar', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user.id);
    const employeeId = scope.employeeIds && scope.employeeIds[0];
    const bounds = monthBounds(req.query.month);
    if (!employeeId) {
      return res.json({ month: bounds.month, calendar: [], incentive: 0, incentiveJobs: 0 });
    }
    const [calendar, incentive] = await Promise.all([
      artistCalendar(employeeId, bounds.start, bounds.end),
      artistIncentiveForMonth(employeeId, bounds.start, bounds.end),
    ]);
    return res.json({
      month: bounds.month, calendar, incentive: incentive.amount, incentiveJobs: incentive.jobs,
    });
  } catch (err) {
    return next(err);
  }
});

// Lets the sales dashboard's calendar page to another month on its own. resolveScope is still
// called, but only to establish that the caller holds a sales-dashboard role at all: the
// calendar itself is shop-wide by design (see salesCalendar), so there is nothing to narrow.
router.get('/sales-calendar', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user.id);
    if (!scope.role) return res.status(403).json({ error: 'Not permitted' });
    const bounds = monthBounds(req.query.month);
    const calendar = await salesCalendar(bounds.start, bounds.end);
    return res.json({ month: bounds.month, calendar });
  } catch (err) {
    return next(err);
  }
});

// The processes under one scheduled job order, with where each one has actually got to.
//
// The calendar could already say a job order was "Not Started" or "Running" as a whole, which is
// the sum of its parts and answers nothing useful: a rep chasing a customer wants to know that
// printing is done and cutting has not started, not that the job is "in progress". These are the
// same rows the production floor works from, read rather than written.
//
// STATUS IS DERIVED, not stored. A process line carries assignment_started_at and
// assignment_ended_at, and every Play/Hold pair opens and closes a row in
// job_order_process_sessions. So:
//   done        -- assignment_ended_at is set
//   in progress -- a session is open right now (started, never held or finished)
//   on hold     -- it has been started, but no session is open and it is not finished
//   not started -- never started
// There is no status column to disagree with, which is why Hold is visible at all: nothing
// writes the word "held" anywhere.
//
// NSTDJO is answered honestly rather than emptily. Non-standard job orders have no process
// table in this build -- they carry materials and a single layout stage
// (layout_started_at / layout_ended_at) -- so the route says so and returns that one stage,
// instead of an empty list that reads as "nothing scheduled".
router.get('/scheduled-processes/:kind/:id', requireAuth, async (req, res, next) => {
  try {
    const kind = String(req.params.kind).toUpperCase();
    if (kind !== 'JO' && kind !== 'NSTDJO') return res.status(400).json({ error: 'Unknown document type.' });

    // Scoped exactly as the calendar that links here: an admin sees any job order, a rep only
    // their own, a supervisor their team's. Anything else is a 404, matching the lists.
    const scope = await resolveScope(req.user.id);
    const unrestricted = scope.role === 'admin';
    const allowed = scope.employeeIds || [];
    if (!unrestricted && !allowed.length) return res.status(404).json({ error: 'Not found' });

    if (kind === 'NSTDJO') {
      const [tbl] = await pool.query("SHOW TABLES LIKE 'non_standard_job_orders'");
      if (!tbl.length) return res.status(404).json({ error: 'Not found' });
      const [[n]] = await pool.query(
        `SELECT n.id, n.nstdjo_no, n.sales_rep_id, n.sub_status,
                n.layout_started_at, n.layout_ended_at,
                CONCAT(a.first_name, ' ', a.last_name) AS artist_name,
                (SELECT COUNT(*) FROM non_standard_job_order_layout_sessions s
                  WHERE s.non_standard_job_order_id = n.id AND s.ended_at IS NULL) AS open_sessions
           FROM non_standard_job_orders n
           LEFT JOIN employees a ON a.id = n.artist_employee_id
          WHERE n.id = ?`, [req.params.id]);
      if (!n) return res.status(404).json({ error: 'Not found' });
      if (!unrestricted && !allowed.map(String).includes(String(n.sales_rep_id))) {
        return res.status(404).json({ error: 'Not found' });
      }
      // Same three states the job order processes report, read the same way: a stage that was
      // started but has no clock running is on hold, not in progress. Calling every started
      // stage "in progress" is what makes a stalled job look like it is moving.
      const status = n.layout_ended_at ? 'done'
        : Number(n.open_sessions) > 0 ? 'in_progress'
        : n.layout_started_at ? 'on_hold' : 'not_started';
      return res.json({
        kind,
        // Said out loud so the screen can explain the single row rather than look broken.
        hasProcesses: false,
        note: 'A non-standard job order is not broken into processes in this build -- it carries one layout stage.',
        processes: [{
          id: n.id,
          lineNo: 1,
          processName: 'Layout',
          itemName: null,
          // The layout stage belongs to the artist the NSTDJO was assigned to. Reporting it
          // as Unassigned was wrong on a document that names an artist.
          assignedTo: n.artist_name && n.artist_name.trim() ? n.artist_name : null,
          status,
          startedAt: n.layout_started_at,
          endedAt: n.layout_ended_at,
        }],
      });
    }

    const [[jo]] = await pool.query('SELECT id, sales_rep_id FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) return res.status(404).json({ error: 'Not found' });
    if (!unrestricted && !allowed.map(String).includes(String(jo.sales_rep_id))) {
      return res.status(404).json({ error: 'Not found' });
    }

    const [rows] = await pool.query(
      `SELECT jop.id, jop.line_no, jop.assignment_started_at, jop.assignment_ended_at,
              jop.total, jop.total_completed, jop.unit,
              pr.process_name, i.display_name AS item_name,
              CONCAT(e.first_name, ' ', e.last_name) AS assigned_to,
              (SELECT COUNT(*) FROM job_order_process_sessions ss
                WHERE ss.job_order_process_id = jop.id AND ss.ended_at IS NULL) AS open_sessions
         FROM job_order_processes jop
         LEFT JOIN processes pr ON pr.id = jop.process_id
         LEFT JOIN inventories i ON i.id = jop.item_id
         LEFT JOIN employees e ON e.id = jop.assigned_employee_id
        WHERE jop.job_order_id = ?
        ORDER BY jop.line_no, jop.id`,
      [req.params.id],
    );

    return res.json({
      kind,
      hasProcesses: true,
      processes: rows.map((r) => ({
        id: r.id,
        lineNo: r.line_no,
        processName: r.process_name,
        itemName: r.item_name,
        assignedTo: r.assigned_to && r.assigned_to.trim() ? r.assigned_to : null,
        status: r.assignment_ended_at ? 'done'
          : Number(r.open_sessions) > 0 ? 'in_progress'
            : r.assignment_started_at ? 'on_hold' : 'not_started',
        startedAt: r.assignment_started_at,
        endedAt: r.assignment_ended_at,
        // How much of the line has been recorded as completed, which is a different question
        // from whether the assignment has been stopped.
        total: r.total,
        totalCompleted: r.total_completed,
        unit: r.unit,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

// The production planner's calendar: every job order whose forecast window (Planned Start ->
// Planned End) touches the month being viewed. Spans are returned as-is rather than expanded
// into one row per day -- a job planned across three weeks would otherwise be sent twenty
// times over; the calendar walks the span itself.
//
// Open to anyone who can see production, plus the department planners who schedule it but hold
// no production permission of their own.
router.get('/production-calendar', requireAuth, async (req, res, next) => {
  try {
    if (!(await isPlannerUser(req.user.id))) {
      const [[perm]] = await pool.query(
        `SELECT atp.can_view FROM users u
           JOIN account_type_permissions atp ON atp.account_type = u.account_type
           JOIN pages p ON p.id = atp.page_id
          WHERE u.id = ? AND p.route = '/production'`,
        [req.user.id]
      );
      const [[u]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [req.user.id]);
      if (u?.account_type !== 'System Admin' && !perm?.can_view) {
        return res.status(403).json({ error: 'Not permitted' });
      }
    }

    const bounds = monthBounds(req.query.month);
    const [rows] = await pool.query(
      `SELECT jo.id, jo.job_order_no AS jobOrderNo, jo.description, jo.quantity, jo.units,
              jo.planned_start_date AS plannedStart, jo.planned_end_date AS plannedEnd,
              jo.delivery_date AS deliveryDate, jo.production_stage AS stage, jo.is_on_hold AS onHold,
              c.name AS customerName, jt.display_name AS jobTypeName, loc.location_name AS jobLocationName,
              -- The JO's sales value (asked 2026-10-06): its Sales Order line's Net of Tax, the basis
              -- Weighted Sales uses. A rework order (RWIP / RFQC, which has a parent) carries none --
              -- its parent's line already counts that sale.
              CASE WHEN jo.parent_job_order_id IS NOT NULL THEN 0
                   ELSE COALESCE((SELECT sol.net_of_tax FROM sales_order_lines sol WHERE sol.job_order_id = jo.id LIMIT 1),
                                 (SELECT sol.net_of_tax FROM sales_order_lines sol WHERE sol.id = jo.sales_order_line_id), 0)
              END AS amount
         FROM job_orders jo
         LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
         LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, (SELECT COALESCE(nx.customer_id, ex.customer_id, sx.customer_id) FROM non_standard_sales_orders nx LEFT JOIN estimates ex ON ex.id = nx.nested_estimate_id LEFT JOIN sales_orders sx ON sx.id = nx.nested_sales_order_id WHERE nx.id = jo.nsso_id))
         LEFT JOIN job_types jt ON jt.id = jo.job_type_id
         LEFT JOIN locations loc ON loc.id = jo.job_location_id
        WHERE jo.planned_start_date IS NOT NULL
          AND jo.planned_end_date IS NOT NULL
          AND jo.status <> 'Cancelled'
          -- Overlap, not containment: a job running across the month boundary belongs on this
          -- month's calendar for the days it actually occupies.
          AND jo.planned_start_date < ?
          AND jo.planned_end_date >= ?
        ORDER BY jo.planned_start_date, jo.job_order_no`,
      [bounds.end, bounds.start]
    );
    return res.json({ month: bounds.month, jobs: rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
// Reused by the chatbot's data-Q&A intents (server/src/lib/chatbotIntents.js) so "what's
// my weighted sales this month" answers with the exact same number this Dashboard
// itself shows, rather than a second, possibly-drifting copy of the same query.
module.exports.resolveScope = resolveScope;
module.exports.repMetrics = repMetrics;
