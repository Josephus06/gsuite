const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

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
    `SELECT u.id, u.employee_id, u.account_type, u.is_account_officer, u.is_supervisor, u.is_sales_manager
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
    // Supervisor: themself + every Account Officer whose supervisor_id points at them.
    const [rows] = await pool.query(
      `SELECT u.id, u.display_name, u.employee_id
       FROM users u WHERE u.supervisor_id = ? OR u.id = ?`,
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

  return {
    weightedSales: { count: Number(weighted.count), amount: Number(weighted.amount) },
    kpi: { winRate: created ? Number(((approved / created) * 100).toFixed(1)) : 0, estimatesCreated: created, estimatesApproved: approved },
    paid: { count: Number(paid.count), amount: Number(paid.amount) },
    unpaid: { count: Number(unpaid.count), amount: Number(unpaid.amount) },
    avgDealSize: allTime.count ? Number((allTime.amount / allTime.count).toFixed(2)) : 0,
    pipeline: pipeline.map((p) => ({ status: p.status, count: Number(p.count) })),
    trend,
  };
}

async function adminMetrics() {
  const [[activeUsers]] = await pool.query('SELECT COUNT(*) AS count FROM users WHERE is_active = TRUE');

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
  };
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user.id);

    if (scope.role === 'admin') {
      const metrics = await adminMetrics();
      return res.json({ role: 'admin', ...metrics });
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

    res.json({ role: scope.role, summary, byRep });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
