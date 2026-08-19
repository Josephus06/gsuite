const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { DESIGN_QUEUE_STATUS } = require('../lib/designSupervisorVisibility');

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

  const [[weighted]] = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount
     FROM sales_orders WHERE sales_rep_id IN (${placeholders}) AND date_created >= ?`,
    [...employeeIds, monthStart]
  );

  const [[estTotals]] = await pool.query(
    `SELECT COUNT(*) AS created, SUM(status = 'approved') AS approved
     FROM estimates WHERE sales_rep_id IN (${placeholders})`,
    employeeIds
  );

  const [[paid]] = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount
     FROM sales_orders WHERE sales_rep_id IN (${placeholders}) AND status = ?`,
    [...employeeIds, PAID_STATUS]
  );

  const unpaidPlaceholders = UNPAID_STATUSES.map(() => '?').join(', ');
  const [[unpaid]] = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount
     FROM sales_orders WHERE sales_rep_id IN (${placeholders}) AND status IN (${unpaidPlaceholders})`,
    [...employeeIds, ...UNPAID_STATUSES]
  );

  const [[allTime]] = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount
     FROM sales_orders WHERE sales_rep_id IN (${placeholders})`,
    employeeIds
  );

  const [pipeline] = await pool.query(
    `SELECT status, COUNT(*) AS count FROM estimates WHERE sales_rep_id IN (${placeholders}) GROUP BY status`,
    employeeIds
  );

  const created = Number(estTotals?.created || 0);
  const approved = Number(estTotals?.approved || 0);
  const trend = await salesTrend(employeeIds);
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

async function adminMetrics() {
  const [[activeUsers]] = await pool.query('SELECT COUNT(*) AS count FROM users WHERE is_active = TRUE');
  const [[userTotals]] = await pool.query('SELECT COUNT(*) AS total FROM users');
  const [[estRingTotals]] = await pool.query(`SELECT COUNT(*) AS total, SUM(status = 'approved') AS approved FROM estimates`);

  const [topCustomers] = await pool.query(
    `SELECT c.id, c.name, COUNT(*) AS order_count, COALESCE(SUM(so.total_amount), 0) AS amount
     FROM sales_orders so JOIN customers c ON c.id = so.customer_id
     GROUP BY c.id, c.name ORDER BY amount DESC LIMIT 5`
  );

  const [trendingJobTypes] = await pool.query(
    `SELECT jt.id, jt.display_name, COUNT(*) AS uses
     FROM sales_order_lines sol JOIN job_types jt ON jt.id = sol.job_type_id
     WHERE sol.job_type_id IS NOT NULL
     GROUP BY jt.id, jt.display_name ORDER BY uses DESC LIMIT 5`
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
  const [[salesThisMonth]] = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount FROM sales_orders WHERE date_created >= ?`,
    [monthStart]
  );
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
    topCustomers: topCustomers.map((c) => ({ id: c.id, name: c.name, orderCount: Number(c.order_count), amount: Number(c.amount) })),
    trendingJobTypes: trendingJobTypes.map((j) => ({ id: j.id, name: j.display_name, uses: Number(j.uses) })),
    salesByDepartment: salesByDepartment.map((d) => ({ id: d.id, name: d.name, orderCount: Number(d.order_count), amount: Number(d.amount) })),
    pendingApprovals: Number(pendingApprovals.count),
    salesThisMonth: { count: Number(salesThisMonth.count), amount: Number(salesThisMonth.amount) },
    trend,
    recentEstimates: recentEstimates.map((r) => ({
      id: r.id, estimateNo: r.estimate_no, status: r.status, totalAmount: Number(r.total_amount || 0),
      customerName: r.customer_name, createdAt: r.created_at,
    })),
    rings: [
      { label: 'Users Active', value: userTotals.total ? Math.round((Number(activeUsers.count) / userTotals.total) * 100) : 0, color: '#7c6fe8' },
      { label: 'Estimates Approved', value: estRingTotals.total ? Math.round((Number(estRingTotals.approved || 0) / estRingTotals.total) * 100) : 0, color: '#4f8cf7' },
      { label: 'Orders Paid', value: orderPaidThisMonth.count ? Math.round((Number(orderPaidThisMonth.paid || 0) / orderPaidThisMonth.count) * 100) : 0, color: '#22c39e' },
    ],
  };
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
     LEFT JOIN customers c ON c.id = so.customer_id
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
  const [[jo]] = await pool.query(
    `SELECT COALESCE(SUM(ROUND(${JO_INCENTIVE_AMOUNT} * COALESCE(NULLIF(jo.layout_qty, 0), 1), 2)), 0) AS amount,
            COUNT(*) AS jobs
       FROM job_orders jo
      WHERE jo.artist_id = ? AND jo.layout_ended_at >= ? AND jo.layout_ended_at < ?`,
    [employeeId, monthStart, monthEnd]
  );

  // The NSTDJO tables are not present in every build -- fall back to the Job Order side alone
  // rather than failing the whole dashboard.
  let nstd = { amount: 0, jobs: 0 };
  const [tbl] = await pool.query("SHOW TABLES LIKE 'non_standard_job_orders'");
  if (tbl.length) {
    const [[row]] = await pool.query(
      `SELECT COALESCE(SUM(ROUND(COALESCE((
                SELECT SUM(m.artist_incentive) FROM non_standard_job_order_materials m
                 WHERE m.non_standard_job_order_id = n.id), 0), 2)), 0) AS amount,
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
            jo.planned_start_at, jo.planned_end_at, jo.layout_ended_at,
            c.name AS customer_name,
            EXISTS(SELECT 1 FROM job_order_layout_sessions s
                    WHERE s.job_order_id = jo.id AND s.ended_at IS NULL) AS is_running
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
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
              n.planned_start_at, n.planned_end_at, n.layout_ended_at,
              c.name AS customer_name,
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
    done: !!r.layout_ended_at,
    running: !!Number(r.is_running),
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

// The sales equivalent of artistCalendar. Two things differ, and both follow from who is
// looking at it.
//
// FIRST, the anchor date. The artist's calendar sits jobs on planned_start_at -- the day they
// are meant to pick the work up. A sales rep is not doing the layout; what they carry is what
// they promised the customer, so a job sits on its DELIVERY date. Anchoring their calendar on
// the layout schedule would show them a month that answers a question they were not asking.
// Where a job has no delivery date yet, it falls back to the planned start rather than
// disappearing from the month altogether -- an invisible job order is the one failure mode a
// calendar must not have -- and the chip says which date it is sitting on.
//
// SECOND, the scope. employeeIds comes from resolveScope, so an account officer sees their own
// jobs and a supervisor or manager sees their team's, exactly as every other figure on this
// dashboard is scoped. There is no rep parameter to point somewhere else.
async function salesCalendar(employeeIds, monthStart, monthEnd) {
  if (!employeeIds.length) return [];
  const placeholders = employeeIds.map(() => '?').join(', ');

  const [rows] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.description, jo.status, jo.sub_status,
            jo.delivery_date, jo.planned_start_at, jo.planned_end_at, jo.layout_ended_at,
            c.name AS customer_name,
            CONCAT(a.first_name, ' ', a.last_name) AS artist_name
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees a ON a.id = jo.artist_id
      WHERE jo.sales_rep_id IN (${placeholders})
        AND COALESCE(jo.delivery_date, jo.planned_start_at) >= ?
        AND COALESCE(jo.delivery_date, jo.planned_start_at) < ?
      ORDER BY COALESCE(jo.delivery_date, jo.planned_start_at)`,
    [...employeeIds, monthStart, monthEnd],
  );

  // Same guard artistCalendar uses -- the NSTDJO tables are not present in every build, and a
  // missing table must degrade to a Job-Orders-only calendar rather than take the dashboard down.
  let nstdjoRows = [];
  const [tbl] = await pool.query("SHOW TABLES LIKE 'non_standard_job_orders'");
  if (tbl.length) {
    [nstdjoRows] = await pool.query(
      `SELECT n.id, n.nstdjo_no AS job_order_no, n.description, n.status, n.sub_status,
              n.delivery_date, n.planned_start_at, n.planned_end_at, n.layout_ended_at,
              c.name AS customer_name,
              CONCAT(a.first_name, ' ', a.last_name) AS artist_name
         FROM non_standard_job_orders n
         LEFT JOIN customers c ON c.id = n.customer_id
         LEFT JOIN employees a ON a.id = n.artist_employee_id
        WHERE n.sales_rep_id IN (${placeholders})
          AND COALESCE(n.delivery_date, n.planned_start_at) >= ?
          AND COALESCE(n.delivery_date, n.planned_start_at) < ?
        ORDER BY COALESCE(n.delivery_date, n.planned_start_at)`,
      [...employeeIds, monthStart, monthEnd],
    );
  }

  const shape = (kind) => (r) => {
    const anchor = r.delivery_date || r.planned_start_at;
    return {
      id: r.id,
      kind,
      jobOrderNo: r.job_order_no,
      description: r.description,
      status: r.status,
      subStatus: r.sub_status,
      customerName: r.customer_name,
      artistName: r.artist_name,
      deliveryDate: r.delivery_date,
      plannedStartAt: r.planned_start_at,
      plannedEndAt: r.planned_end_at,
      // Which date this chip is actually sitting on, so the tooltip can say so rather than
      // leaving the rep to guess why a job is on the day it is.
      anchor: r.delivery_date ? 'delivery' : 'planned',
      done: !!r.layout_ended_at,
      // Sliced off the string rather than parsed into a Date: at UTC+8 a DATE column read back
      // through new Date() lands at 08:00 and can format onto the previous day.
      day: anchor ? String(anchor).slice(0, 10) : null,
    };
  };

  return [...rows.map(shape('JO')), ...nstdjoRows.map(shape('NSTDJO'))]
    .sort((a, b) => String(a.day || '').localeCompare(String(b.day || '')));
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user.id);

    if (scope.role === 'admin') {
      const metrics = await adminMetrics();
      return res.json({ role: 'admin', ...metrics });
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
    const calendar = await salesCalendar(scope.employeeIds, bounds.start, bounds.end);

    res.json({ role: scope.role, summary, byRep, calendar, calendarMonth: bounds.month });
  } catch (err) {
    next(err);
  }
});

// Lets the artist dashboard's calendar page to another month without refetching the whole
// dashboard. Scoped to the caller's own employee record -- an artist only ever sees their own
// schedule, and there is no artist_id parameter to point somewhere else.
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

// Lets the sales dashboard's calendar page to another month on its own. Scoped through
// resolveScope exactly as the dashboard itself is, so paging the calendar can never widen what
// a rep is allowed to see.
router.get('/sales-calendar', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user.id);
    const bounds = monthBounds(req.query.month);
    const calendar = await salesCalendar(scope.employeeIds || [], bounds.start, bounds.end);
    return res.json({ month: bounds.month, calendar });
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
