const pool = require('../db');
const { releaseByMonthForEmployee } = require('./commissionRelease');

// Commission report (Commission module > Reports > Commission): one sales rep, one year,
// twelve month rows. Every figure is defined by the client:
//
//   Quota                     -- the rep's employee_quota for that month
//   Weighted Sales            -- SUM(net of tax) of ALL the rep's JOs that month (by SO date)
//   %                         -- Weighted Sales / Quota * 100
//   Estimated Commission      -- the rep's commission scheme looked up at Weighted Sales
//   Total Amount of JOs w/     \  SUM(net of tax) of only the rep's JOs whose own GP rate
//     passing GP rate         /   meets the job type's defined passing GP rate
//   Expected Commission       -- the scheme looked up at that passing-GP total
//   Confirmed Commission      -- (paid invoice of passing JOs / passing total) * Expected
//   Released Commission       -- TODO: needs a not-yet-built source; 0 for now
//   Unpaid Commission         -- Confirmed - Released
//
// Which scheme applies is decided by the rep's role flag on their user account, not chosen
// -- an Account Officer is read against the Account Officer scheme, a Supervisor against
// Sales Supervisor, and so on. Passing GP is the job type's Head-Office rate (gp_rate_head),
// matching the report's Head Office context.
//
// A rep's sales are their whole TEAM's, not just their own: a supervisor's Weighted Sales
// and passing-GP total roll up their own JOs plus every subordinate's, down the reporting
// tree (users.supervisor_id). A supervisor with two account officers under them is read at
// own + both AOs; a manager rolls up their supervisors and those supervisors' AOs; an
// account officer (no one beneath them) rolls up to just their own. This is why the scheme
// is looked up at a team-sized number.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Role flag -> scheme name, most senior first. A rep carrying several flags is read
// against the most senior scheme they hold.
const ROLE_TO_SCHEME = [
  { flag: 'is_sales_business_unit', scheme: 'SBU Head' },
  { flag: 'is_sales_manager', scheme: 'Sales Manager' },
  { flag: 'is_supervisor', scheme: 'Sales Supervisor' },
  { flag: 'is_account_officer', scheme: 'Account Officer' },
];

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// A scheme is a ladder of Total-Weighted-Sales brackets -> a fixed commission amount. Find
// the bracket the amount falls in. Below the first bracket pays nothing; above the last
// bracket earns the top bracket's amount (the ladder doesn't cap what it recognises).
function lookupCommission(brackets, amount) {
  const amt = Number(amount) || 0;
  if (amt <= 0 || !brackets.length) return 0;
  for (const b of brackets) {
    if (amt >= Number(b.min_weighted_sales) && amt <= Number(b.max_weighted_sales)) return Number(b.commission_amount) || 0;
  }
  const top = brackets.reduce((a, b) => (Number(b.max_weighted_sales) > Number(a.max_weighted_sales) ? b : a));
  if (amt > Number(top.max_weighted_sales)) return Number(top.commission_amount) || 0;
  return 0;
}

// The rep plus everyone reporting up to them, as a set of employee ids -- what their team
// weighted-sales rolls up. Walks the users.supervisor_id tree downward from the rep's own
// user; a rep with no user account (or no reports) rolls up to just themselves.
async function getTeamEmployeeIds(employeeId, rootUserId) {
  const team = new Set([Number(employeeId)]);
  if (!rootUserId) return [...team];

  // One pass over the active user tree, then BFS from the root user downward.
  const [users] = await pool.query('SELECT id, employee_id, supervisor_id FROM users WHERE is_active = TRUE');
  const childrenBySupervisor = new Map();
  for (const u of users) {
    if (u.supervisor_id == null) continue;
    if (!childrenBySupervisor.has(u.supervisor_id)) childrenBySupervisor.set(u.supervisor_id, []);
    childrenBySupervisor.get(u.supervisor_id).push(u);
  }
  const queue = [rootUserId];
  const visitedUsers = new Set([rootUserId]);
  while (queue.length) {
    const uid = queue.shift();
    for (const child of childrenBySupervisor.get(uid) || []) {
      if (visitedUsers.has(child.id)) continue; // guard against any accidental cycle
      visitedUsers.add(child.id);
      if (child.employee_id != null) team.add(Number(child.employee_id));
      queue.push(child.id);
    }
  }
  return [...team];
}

// The sales divisions a Sales Business Unit owns -- its commission rolls up every sale in
// these, division-wide, on top of the reporting-tree rollup above.
async function getSbuDivisionIds(userId) {
  if (!userId) return [];
  const [rows] = await pool.query('SELECT sales_division_id FROM user_sales_divisions WHERE user_id = ?', [userId]);
  return rows.map((r) => r.sales_division_id);
}

function resolveScheme(user, brackets) {
  if (!user) return { schemeName: null, brackets: [] };
  const match = ROLE_TO_SCHEME.find((r) => user[r.flag]);
  return { schemeName: match ? match.scheme : null, brackets: match ? brackets : [] };
}

async function loadSchemeBrackets(schemeName) {
  if (!schemeName) return [];
  const [[scheme]] = await pool.query('SELECT id FROM commission_schemes WHERE name = ? AND is_active = TRUE LIMIT 1', [schemeName]);
  if (!scheme) return [];
  const [brackets] = await pool.query(
    `SELECT min_weighted_sales, max_weighted_sales, commission_amount, commission_rate
     FROM commission_scheme_brackets WHERE commission_scheme_id = ? ORDER BY sort_order, id`,
    [scheme.id]
  );
  return brackets;
}

async function buildCommissionReport(employeeId, year, filters = {}) {
  const [[employee]] = await pool.query(
    `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name FROM employees e WHERE e.id = ?`,
    [employeeId]
  );
  if (!employee) return null;

  // The rep's user account carries both the role flag (which scheme) and, for an SBU, its
  // owned divisions -- fetch it once.
  const [[user]] = await pool.query(
    `SELECT id, is_account_officer, is_supervisor, is_sales_manager, is_sales_business_unit
     FROM users WHERE employee_id = ? AND is_active = TRUE ORDER BY id LIMIT 1`,
    [employeeId]
  );
  const { schemeName } = resolveScheme(user, []);
  const brackets = await loadSchemeBrackets(schemeName);
  const teamEmployeeIds = await getTeamEmployeeIds(employeeId, user ? user.id : null);
  const sbuDivisionIds = user && user.is_sales_business_unit ? await getSbuDivisionIds(user.id) : [];

  // A rep's sales are their reporting team's (sales_rep_id in the team). An SBU owns whole
  // divisions on top of that, so its sales also include everything in the divisions it
  // owns, whoever the rep was. The two are unioned.
  const whereParts = [];
  const params = [];
  // Attribute by the SALES ORDER's rep (matches the live report's "Sales Rep" column), so an
  // order still pending its job order -- and any order whose job's rep differs from its sales
  // rep -- is credited to the sales order's owning rep exactly as live does.
  if (sbuDivisionIds.length) {
    whereParts.push('(so.sales_rep_id IN (?) OR so.sales_division_id IN (?))');
    params.push(teamEmployeeIds, sbuDivisionIds);
  } else {
    whereParts.push('so.sales_rep_id IN (?)');
    params.push(teamEmployeeIds);
  }
  whereParts.push('YEAR(so.date_created) = ?');
  params.push(year);
  // Cancelled sales orders never count toward weighted sales (or anything downstream).
  whereParts.push("(so.status IS NULL OR so.status <> 'cancelled')");
  if (filters.salesDivisionId) { whereParts.push('so.sales_division_id = ?'); params.push(filters.salesDivisionId); }

  // Weighted sales is every (non-cancelled) sales-order LINE -- including lines on orders that
  // have not had their job order created yet (status pending_for_jo). So the base table is
  // sales_order_lines, with the job order left-joined in only for the passing-GP / paid logic.
  const [lines] = await pool.query(
    `SELECT jo.id AS jo_id, MONTH(so.date_created) AS month,
            so.sales_division_id, sd.name AS division_name,
            COALESCE(sol.net_of_tax, 0) AS net_of_tax,
            -- Some orders (esp. "... WITH INSTALLATION") carry GP only at the order level, not
            -- per line, so sol.gp_rate lands 0; fall back to the order's actual GP so those JOs
            -- aren't wrongly judged Below-GP (0% is impossible for a real, costed line).
            COALESCE(NULLIF(sol.gp_rate, 0), so.actual_gp_rate) AS jo_gp_rate, jt.gp_rate_head AS passing_gp_rate,
            sol.is_approved_low_gp
     FROM sales_order_lines sol
     JOIN sales_orders so ON so.id = sol.sales_order_id
     LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
     LEFT JOIN job_types jt ON jt.id = sol.job_type_id
     LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
     WHERE ${whereParts.join(' AND ')}`,
    params
  );

  // A line passes when it has a job order whose GP rate meets the job type's passing rate. A
  // line with no job order yet, no GP rate, or no defined threshold can't be judged as passing
  // -- it still counts in weighted sales, just not in the passing-rate total.
  const passingJoIds = [];
  for (const l of lines) {
    // Normally a line passes on GP rate; but an Admin/GM low-GP approval (is_approved_low_gp) forces
    // it to count as passing regardless of the rate, as long as it has a job order.
    const meetsGp = l.jo_gp_rate != null && l.passing_gp_rate != null && Number(l.jo_gp_rate) >= Number(l.passing_gp_rate);
    l.passing = l.jo_id != null && (Number(l.is_approved_low_gp) === 1 || meetsGp);
    if (l.passing) passingJoIds.push(l.jo_id);
  }

  // Paid portion of each passing JO, from its sales order's invoice payment. Uses the same
  // order-level attribution as the JO-detail report (computePaidByJo) so DT-converted invoices
  // -- whose lines carry no job_order_id -- are counted; the old line-level join silently
  // dropped them and understated Confirmed Commission.
  const paidByJo = await computePaidByJo(passingJoIds);

  const [quotaRows] = await pool.query(
    'SELECT month, quota FROM employee_quotas WHERE employee_id = ? AND year = ?',
    [employeeId, year]
  );
  const quotaByMonth = new Map(quotaRows.map((q) => [q.month, Number(q.quota)]));

  // Fold everything into the twelve month rows.
  const months = MONTHS.map((label, i) => ({
    month: i + 1, month_name: label, quota: quotaByMonth.get(i + 1) || 0,
    division_name: null, weighted_sales: 0, passing_total: 0, paid_passing: 0,
  }));

  for (const l of lines) {
    const row = months[l.month - 1];
    if (!row) continue;
    row.weighted_sales += Number(l.net_of_tax);
    if (!row.division_name && l.division_name) row.division_name = l.division_name;
    if (l.passing) {
      row.passing_total += Number(l.net_of_tax);
      row.paid_passing += paidByJo.get(l.jo_id) || 0;
    }
  }

  // Released commission + voucher expense adjustments, sourced from this employee's Commission
  // Vouchers via the shared waterfall allocation (deductions from the earliest month, refunds
  // added, net = the voucher's total). See lib/commissionRelease.js.
  const { releasedByMonth, deductedByMonth, refundedByMonth } = await releaseByMonthForEmployee(employeeId, year);

  const rows = months.map((r) => {
    const weighted = round2(r.weighted_sales);
    const passingTotal = round2(r.passing_total);
    const paid = round2(r.paid_passing);
    const estimated = round2(lookupCommission(brackets, weighted));
    const expected = round2(lookupCommission(brackets, passingTotal));
    const confirmed = passingTotal > 0 ? round2((paid / passingTotal) * expected) : 0;
    const released = round2(releasedByMonth[r.month]);
    const deducted = round2(deductedByMonth[r.month]);
    const refunded = round2(refundedByMonth[r.month]);
    // Unpaid = Confirmed − (Released + Deducted): the deduction lowers what's still owed, and a
    // later refund that cancels the deduction restores it (released goes up, deducted goes to 0).
    const unpaid = round2(confirmed - (released + deducted));
    const pct = r.quota > 0 ? round2((weighted / r.quota) * 100) : 0;
    return {
      month: r.month, month_name: r.month_name, quota: round2(r.quota),
      division_name: r.division_name, weighted_sales: weighted, performance_pct: pct,
      estimated_commission: estimated, passing_gp_total: passingTotal,
      expected_commission: expected, confirmed_commission: confirmed,
      released_commission: released, expenses_deducted: deducted, expenses_refunded: refunded,
      unpaid_commission: unpaid,
    };
  });

  return {
    employee_id: employee.id, employee_name: employee.name, year: Number(year),
    scheme_name: schemeName, team_size: teamEmployeeIds.length,
    sbu_division_count: sbuDivisionIds.length, rows,
  };
}

// The paid (net) portion of each JO, allocated from its invoices: each invoice line takes
// its share of that invoice's paid fraction (gross - amount_due) / gross. Voided invoices
// count as nothing paid. Same allocation the monthly report uses, generalised to any JOs.
// Paid-invoice amount attributable to each JO. Billing is at the sales-order level (an invoice,
// or a Delivery Ticket that converted to one), so we work from the SO's invoice payment rather
// than an invoice-line -> JO link: those links are only best-effort on the original importer and
// are entirely absent on DT-converted invoices (whose lines carry no JO). For each JO we take its
// own net-of-tax (the same figure the report commissions on) times its SO's paid fraction --
// gross collected / gross invoiced. That way a paid-in-full invoice marks its JOs' full net as
// paid, uniformly for original and DT-converted invoices alike.
async function computePaidByJo(joIds) {
  const paidByJo = new Map();
  if (!joIds.length) return paidByJo;
  const [jos] = await pool.query(
    `SELECT jo.id AS jo_id, jo.sales_order_id, COALESCE(sol.net_of_tax, 0) AS jo_net
       FROM job_orders jo
       LEFT JOIN sales_order_lines sol ON sol.id = jo.sales_order_line_id
      WHERE jo.id IN (?)`,
    [joIds]
  );
  const soIds = [...new Set(jos.map((j) => j.sales_order_id))];
  const fractionBySo = new Map();
  if (soIds.length) {
    const [inv] = await pool.query(
      `SELECT sales_order_id, SUM(gross_amount) AS gross, SUM(gross_amount - amount_due) AS paid
         FROM sales_invoices
        WHERE sales_order_id IN (?) AND (status IS NULL OR status <> 'cancelled')
        GROUP BY sales_order_id`,
      [soIds]
    );
    for (const r of inv) {
      const gross = Number(r.gross) || 0;
      fractionBySo.set(r.sales_order_id, gross > 0 ? (Number(r.paid) / gross) : 0);
    }
  }
  for (const j of jos) {
    const frac = fractionBySo.get(j.sales_order_id) || 0;
    if (frac) paidByJo.set(j.jo_id, (paidByJo.get(j.jo_id) || 0) + Number(j.jo_net) * frac);
  }
  return paidByJo;
}

// Per-JO detail behind one rep's commission for a single month: every JO in the rep's team
// (own + downline, plus any SBU-owned divisions), each with its GP rate, net of tax, and
// paid-invoice amount, split into JOs that met their job type's passing GP rate and those
// below it. This is the line-by-line backing for the monthly report's passing-GP total and
// its Confirmed figure.
async function buildCommissionJoDetail(employeeId, year, month, filters = {}) {
  const [[employee]] = await pool.query(
    "SELECT id, CONCAT(first_name, ' ', last_name) AS name FROM employees WHERE id = ?", [employeeId]
  );
  if (!employee) return null;

  const [[user]] = await pool.query(
    `SELECT id, is_sales_business_unit FROM users WHERE employee_id = ? AND is_active = TRUE ORDER BY id LIMIT 1`,
    [employeeId]
  );
  const teamEmployeeIds = await getTeamEmployeeIds(employeeId, user ? user.id : null);
  const sbuDivisionIds = user && user.is_sales_business_unit ? await getSbuDivisionIds(user.id) : [];

  const whereParts = [];
  const params = [];
  if (sbuDivisionIds.length) {
    whereParts.push('(so.sales_rep_id IN (?) OR so.sales_division_id IN (?))');
    params.push(teamEmployeeIds, sbuDivisionIds);
  } else {
    whereParts.push('so.sales_rep_id IN (?)');
    params.push(teamEmployeeIds);
  }
  whereParts.push('YEAR(so.date_created) = ?'); params.push(Number(year));
  whereParts.push('MONTH(so.date_created) = ?'); params.push(Number(month));
  // Cancelled sales orders are excluded here too, so the detail matches the monthly totals.
  whereParts.push("(so.status IS NULL OR so.status <> 'cancelled')");
  if (filters.salesDivisionId) { whereParts.push('so.sales_division_id = ?'); params.push(filters.salesDivisionId); }

  const [jos] = await pool.query(
    `SELECT jo.id AS jo_id, jo.job_order_no, so.sales_order_no, c.name AS customer_name,
            jt.display_name AS job_type, COALESCE(sol.net_of_tax, 0) AS net_of_tax,
            -- Fall back to the order-level actual GP when the line has none (see buildCommissionReport).
            COALESCE(NULLIF(sol.gp_rate, 0), so.actual_gp_rate) AS jo_gp_rate, jt.gp_rate_head AS passing_gp_rate,
            sol.id AS sales_order_line_id, sol.is_approved_low_gp,
            CONCAT(rep.first_name, ' ', rep.last_name) AS rep_name,
            -- Billing docs are at the sales-order level: a DT (internal invoice) and/or the
            -- Sales Invoice it converts to. Show both when present (all JOs of one SO share them).
            (SELECT dt.dt_no FROM delivery_tickets dt
              WHERE dt.sales_order_id = so.id AND dt.status <> 'void' ORDER BY dt.id LIMIT 1) AS dt_no,
            (SELECT si.invoice_no FROM sales_invoices si
              WHERE si.sales_order_id = so.id AND (si.status IS NULL OR si.status <> 'cancelled')
              ORDER BY si.id LIMIT 1) AS invoice_no
     FROM job_orders jo
     JOIN sales_orders so ON so.id = jo.sales_order_id
     LEFT JOIN sales_order_lines sol ON sol.id = jo.sales_order_line_id
     LEFT JOIN job_types jt ON jt.id = jo.job_type_id
     LEFT JOIN customers c ON c.id = so.customer_id
     LEFT JOIN employees rep ON rep.id = jo.sales_rep_id
     WHERE ${whereParts.join(' AND ')}
     ORDER BY so.date_created, jo.job_order_no`,
    params
  );

  const paidByJo = await computePaidByJo(jos.map((j) => j.jo_id));

  const totals = {
    passing: { net_of_tax: 0, paid_invoice: 0, count: 0 },
    below: { net_of_tax: 0, paid_invoice: 0, count: 0 },
  };
  const rows = jos.map((j) => {
    // Same rule the monthly report uses: a JO passes on its GP rate, OR because someone added
    // it to commission explicitly (is_approved_low_gp). This detail used to judge on the rate
    // alone, so an added JO still read "Below GP" here while already counting toward the
    // month's passing total -- the two screens disagreed about the same job order.
    const meetsGp = j.jo_gp_rate != null && j.passing_gp_rate != null
      && Number(j.jo_gp_rate) >= Number(j.passing_gp_rate);
    const addedManually = Number(j.is_approved_low_gp) === 1;
    const isPassing = meetsGp || addedManually;
    const net = round2(j.net_of_tax);
    const paid = round2(paidByJo.get(j.jo_id) || 0);
    const bucket = isPassing ? totals.passing : totals.below;
    bucket.net_of_tax = round2(bucket.net_of_tax + net);
    bucket.paid_invoice = round2(bucket.paid_invoice + paid);
    bucket.count += 1;
    return {
      job_order_no: j.job_order_no, sales_order_no: j.sales_order_no, customer_name: j.customer_name,
      rep_name: j.rep_name, job_type: j.job_type, gp_rate: j.jo_gp_rate == null ? null : Number(j.jo_gp_rate),
      passing_gp_rate: j.passing_gp_rate == null ? null : Number(j.passing_gp_rate),
      dt_no: j.dt_no || null, invoice_no: j.invoice_no || null,
      net_of_tax: net, paid_invoice: paid, is_passing: isPassing,
      // The UI needs to tell "passed on its own GP" apart from "was added": only the latter
      // can be taken back out, and only a JO that has a line can be added in the first place.
      meets_gp: meetsGp, is_approved_low_gp: addedManually,
      sales_order_line_id: j.sales_order_line_id || null,
    };
  });

  return {
    employee_id: employee.id, employee_name: employee.name, year: Number(year), month: Number(month),
    team_size: teamEmployeeIds.length, sbu_division_count: sbuDivisionIds.length, rows, totals,
  };
}

module.exports = { buildCommissionReport, buildCommissionJoDetail, getTeamEmployeeIds, getSbuDivisionIds };
