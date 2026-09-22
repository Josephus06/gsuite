const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { buildTrialBalance, buildBalanceSheet, buildIncomeStatement, buildGeneralLedger, buildGlTransactions } = require('../lib/reportsEngine');
const {
  buildArAging, buildArAgingCustomerDetails, buildArAgingCustomerLedger,
  buildArAgingDetails, buildArAgingDetailsCsv, searchArCustomers,
} = require('../lib/arAging');
const { parkedReport } = require('../lib/parkedBankItems');
const { buildCommissionReport, buildCommissionJoDetail, getTeamEmployeeIds, getSbuDivisionIds } = require('../lib/commissionReport');
const {
  buildProfitabilityReport, buildProfitabilityCsv, buildProfitabilityLineDetail,
  getProfitabilityScope, searchProfitabilityCustomers,
} = require('../lib/profitabilityReport');
const { resolveDefaultLocation } = require('../lib/userLocation');
const pool = require('../db');

const router = express.Router();

function today() { return new Date().toISOString().slice(0, 10); }

// Which sales reps the logged-in user may pull a commission report for:
//   - System Admin / back-office (no sales-scoping role) -> everyone ({ all: true }).
//   - Supervisor / Sales Manager / SBU -> their reporting team (own + downline), plus, for an
//     SBU, every rep who sold in a division it owns.
//   - Account Officer / plain Sales -> only themselves.
async function getCommissionScope(userId) {
  const [[u]] = await pool.query(
    `SELECT id, employee_id, account_type, is_account_officer, is_supervisor, is_sales_manager, is_sales_business_unit
       FROM users WHERE id = ? AND is_active = TRUE`,
    [userId]
  );
  if (!u) return { all: false, allowedIds: new Set(), selfOnly: false, selfId: null };
  const selfId = u.employee_id != null ? Number(u.employee_id) : null;
  const isSalesScoped = u.account_type === 'Sales' || u.is_account_officer || u.is_supervisor
    || u.is_sales_manager || u.is_sales_business_unit;
  if (u.account_type === 'System Admin' || !isSalesScoped) return { all: true, allowedIds: null, selfOnly: false, selfId };

  if (u.is_supervisor || u.is_sales_manager || u.is_sales_business_unit) {
    const allowed = new Set(await getTeamEmployeeIds(u.employee_id, u.id));
    if (u.is_sales_business_unit) {
      const divs = await getSbuDivisionIds(u.id);
      if (divs.length) {
        const [reps] = await pool.query(
          'SELECT DISTINCT sales_rep_id FROM sales_orders WHERE sales_division_id IN (?) AND sales_rep_id IS NOT NULL',
          [divs]
        );
        reps.forEach((r) => allowed.add(Number(r.sales_rep_id)));
      }
    }
    return { all: false, allowedIds: allowed, selfOnly: false, selfId };
  }
  // Account officer / plain sales user: only their own report -- no rep picker, just their own.
  return { all: false, allowedIds: new Set(selfId != null ? [selfId] : []), selfOnly: true, selfId };
}

// The commissioned sales reps a given scope may report on (feeds the picker).
async function scopedReps(scope) {
  if (!scope.all && scope.allowedIds.size === 0) return [];
  const scopeClause = scope.all ? '' : 'AND e.id IN (?)';
  const params = scope.all ? [] : [[...scope.allowedIds]];
  const [rows] = await pool.query(
    `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name
       FROM employees e
       WHERE e.is_active = TRUE AND EXISTS (
         SELECT 1 FROM users u WHERE u.employee_id = e.id AND u.is_active = TRUE
           AND (u.account_type = 'Sales' OR u.is_account_officer OR u.is_supervisor
                OR u.is_sales_manager OR u.is_sales_business_unit))
       ${scopeClause}
       ORDER BY name`,
    params
  );
  return rows;
}

router.get('/trial-balance', requireAuth, requirePermission('/reports/trial-balance', 'can_view'), async (req, res, next) => {
  try {
    res.json(await buildTrialBalance(req.query.asOf || today()));
  } catch (err) {
    next(err);
  }
});

const VALID_BREAKDOWNS = ['total', 'months', 'location', 'department'];
router.get('/income-statement', requireAuth, requirePermission('/reports/income-statement', 'can_view'), async (req, res, next) => {
  try {
    const breakdown = VALID_BREAKDOWNS.includes(req.query.breakdown) ? req.query.breakdown : 'total';
    res.json(await buildIncomeStatement(req.query.asOf || today(), req.query.from || null, breakdown));
  } catch (err) {
    next(err);
  }
});

router.get('/balance-sheet', requireAuth, requirePermission('/reports/balance-sheet', 'can_view'), async (req, res, next) => {
  try {
    res.json(await buildBalanceSheet(req.query.asOf || today()));
  } catch (err) {
    next(err);
  }
});

// What is still parked in the Deposit / Disbursement accounts waiting to be identified.
//
// Those two carry exclude_from_reports, so no other report totals them -- which is exactly why
// this one has to exist. See lib/parkedBankItems.js. The nightly reminder reads the same
// function, so the report and the notification can never disagree about whether there is
// anything to chase.
router.get('/parked-bank-items', requireAuth, requirePermission('/reports/parked-bank-items', 'can_view'), async (req, res, next) => {
  try {
    res.json(await parkedReport({ accountCode: req.query.account_code || null }));
  } catch (err) {
    next(err);
  }
});

router.get('/general-ledger', requireAuth, requirePermission('/reports/general-ledger', 'can_view'), async (req, res, next) => {
  try {
    res.json(await buildGeneralLedger(req.query.asOf || today(), req.query.from || null));
  } catch (err) {
    next(err);
  }
});

// Drill-down behind an income-statement amount: the transactions for one account, scoped to
// the clicked column (department/location/month) over the report period.
router.get('/income-statement/transactions', requireAuth, requirePermission('/reports/income-statement', 'can_view'), async (req, res, next) => {
  try {
    if (!req.query.accountCode) return res.status(400).json({ error: 'accountCode is required.' });
    res.json(await buildGlTransactions({
      accountCode: req.query.accountCode,
      breakdown: req.query.breakdown || 'total',
      columnKey: req.query.columnKey || 'total',
      asOfDate: req.query.asOf || today(),
      fromDate: req.query.from || null,
    }));
  } catch (err) {
    next(err);
  }
});

const AR_AGING_ROUTE = '/reports/ar-aging';

router.get('/ar-aging', requireAuth, requirePermission(AR_AGING_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const filters = {
      locationId: req.query.locationId ? Number(req.query.locationId) : null,
      noLocation: req.query.noLocation === 'true' || req.query.noLocation === '1',
      nameStarts: req.query.nameStarts || null,
    };
    res.json(await buildArAging(req.query.asOf || today(), filters));
  } catch (err) {
    next(err);
  }
});

router.get('/ar-aging/customer/:customerId/details', requireAuth, requirePermission(AR_AGING_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const data = await buildArAgingCustomerDetails(Number(req.params.customerId), req.query.asOf || today());
    if (!data) return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/ar-aging/customer/:customerId/ledger', requireAuth, requirePermission(AR_AGING_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const data = await buildArAgingCustomerLedger(Number(req.params.customerId), req.query.asOf || today());
    if (!data) return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ---- Accounting > Reports > AR Aging Details ----
//
// Its own pages row rather than borrowing AR Aging's: a borrowed scope is what produces a 500
// instead of a 403 on an install where the row is missing, and it takes the ability to grant one
// report without the other away from whoever maintains permissions.
const AR_AGING_DETAILS_ROUTE = '/reports/ar-aging-details';

function arAgingDetailsFilters(query) {
  return {
    customerId: query.customerId && Number(query.customerId) > 0 ? Number(query.customerId) : null,
    locationId: query.locationId && Number(query.locationId) > 0 ? Number(query.locationId) : null,
    noLocation: query.noLocation === 'true' || query.noLocation === '1',
    nameStarts: query.nameStarts ? String(query.nameStarts).slice(0, 100) : null,
    page: query.page,
    limit: query.limit,
  };
}

router.get('/ar-aging-details', requireAuth, requirePermission(AR_AGING_DETAILS_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const asOf = req.query.asOf || today();
    const filters = arAgingDetailsFilters(req.query);
    if (req.query.format === 'csv') {
      const { csv } = await buildArAgingDetailsCsv(asOf, filters);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ar-aging-details-${asOf}.csv"`);
      return res.send(csv);
    }
    return res.json(await buildArAgingDetails(asOf, filters));
  } catch (err) {
    return next(err);
  }
});

router.get('/ar-aging-details/customers', requireAuth, requirePermission(AR_AGING_DETAILS_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    return res.json(await searchArCustomers(req.query.q));
  } catch (err) {
    return next(err);
  }
});

const COMMISSION_ROUTE = '/commission-report';

// Feeds the report's Sales Rep picker: only employees who are commissioned sales users
// (a Sales account with a role flag that maps to a scheme), so the picker isn't the whole
// 100+ employee list.
router.get('/commission/sales-reps', requireAuth, requirePermission(COMMISSION_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    res.json(await scopedReps(await getCommissionScope(req.user.id)));
  } catch (err) {
    next(err);
  }
});

// Tells the report page how to present itself for the logged-in user: an Account Officer /
// plain sales user reports only on themselves (self_only -> no rep picker, auto-target self);
// everyone else picks from their allowed reps.
router.get('/commission/scope', requireAuth, requirePermission(COMMISSION_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const scope = await getCommissionScope(req.user.id);
    const reps = await scopedReps(scope);
    const self = scope.selfId != null ? reps.find((r) => r.id === scope.selfId) || null : null;
    res.json({ self_only: scope.selfOnly, self, reps });
  } catch (err) {
    next(err);
  }
});

router.get('/commission', requireAuth, requirePermission(COMMISSION_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'A Sales Rep is required.' });
    const scope = await getCommissionScope(req.user.id);
    if (!scope.all && !scope.allowedIds.has(employeeId)) {
      return res.status(403).json({ error: 'You can only generate commission reports for yourself or your team.' });
    }
    const year = Number(req.query.year) || new Date().getFullYear();
    const filters = { salesDivisionId: req.query.salesDivisionId ? Number(req.query.salesDivisionId) : null };
    const data = await buildCommissionReport(employeeId, year, filters);
    if (!data) return res.status(404).json({ error: 'Sales Rep not found' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Per-JO detail for one rep + month: JO#, GP rate, net of tax, paid invoice, split into
// passing-GP and below-GP.
router.get('/commission/jo-detail', requireAuth, requirePermission(COMMISSION_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'A Sales Rep is required.' });
    const scope = await getCommissionScope(req.user.id);
    if (!scope.all && !scope.allowedIds.has(employeeId)) {
      return res.status(403).json({ error: 'You can only generate commission reports for yourself or your team.' });
    }
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = Number(req.query.month) || (new Date().getMonth() + 1);
    if (month < 1 || month > 12) return res.status(400).json({ error: 'Month must be 1-12.' });
    const filters = { salesDivisionId: req.query.salesDivisionId ? Number(req.query.salesDivisionId) : null };
    const data = await buildCommissionJoDetail(employeeId, year, month, filters);
    if (!data) return res.status(404).json({ error: 'Sales Rep not found' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// "Add to Commission" on the JO Detail screen: count this job order toward the rep's
// passing-GP total even though its GP rate is below the job type's threshold.
//
// It sets the same sales_order_lines.is_approved_low_gp flag the estimate-approval path already
// writes, which both the monthly Commission report and the JO Detail read, so an added JO is
// treated as passing everywhere rather than only on the screen it was added from.
//
// Gated on can_approve, not can_edit: this is the low-GP concession that used to require an
// Admin/GM decision, and it moves real money into a rep's commission.
router.post('/commission/jo-detail/add-to-commission', requireAuth, requirePermission(COMMISSION_ROUTE, 'can_approve'), async (req, res, next) => {
  try {
    const lineId = Number(req.body?.sales_order_line_id);
    const include = req.body?.include !== false; // default: add. false takes it back out.
    if (!lineId) return res.status(400).json({ error: 'sales_order_line_id is required.' });

    const [[line]] = await pool.query(
      `SELECT sol.id, sol.is_approved_low_gp, so.status AS so_status,
              jo.id AS jo_id, jo.job_order_no
         FROM sales_order_lines sol
         JOIN sales_orders so ON so.id = sol.sales_order_id
         LEFT JOIN job_orders jo ON jo.sales_order_line_id = sol.id
        WHERE sol.id = ?`, [lineId]
    );
    if (!line) return res.status(404).json({ error: 'Sales order line not found.' });
    // The commission report only ever counts a line that reached a job order, so adding one
    // that has none would look like it worked and change nothing.
    if (!line.jo_id) return res.status(409).json({ error: 'This line has no job order yet, so it cannot be added to commission.' });
    if (line.so_status === 'cancelled') return res.status(409).json({ error: 'A cancelled sales order cannot be added to commission.' });

    await pool.query('UPDATE sales_order_lines SET is_approved_low_gp = ? WHERE id = ?', [include ? 1 : 0, lineId]);
    return res.json({ sales_order_line_id: lineId, job_order_no: line.job_order_no, is_approved_low_gp: include });
  } catch (err) {
    return next(err);
  }
});

// ---- Accounting > Reports > Profitability Report ----
//
// Four endpoints behind one permission: the report itself (with ?format=csv for Download), the
// pickers' contents, the Customer typeahead, and one child row's Details. All on can_view --
// nothing here writes, and the numbers are already visible on the documents they come from.
const PROFITABILITY_ROUTE = '/reports/profitability';

// Parsed once, here, so the lib is handed clean values and the query string cannot reach the SQL
// builder as, say, a page number of "1; DROP".
function profitabilityFilters(query) {
  const id = (v) => (v && Number(v) > 0 ? Number(v) : null);
  return {
    search: query.search ? String(query.search).slice(0, 100) : '',
    salesRepId: id(query.sales_rep_id),
    customerId: id(query.customer_id),
    officeLocationId: id(query.office_location_id),
    salesDivisionId: id(query.sales_division_id),
    dateMode: query.date_mode ? String(query.date_mode) : 'as_of',
    dateFrom: query.date_from ? String(query.date_from).slice(0, 10) : '',
    dateTo: query.date_to ? String(query.date_to).slice(0, 10) : '',
    includeCancelled: query.include_cancelled === 'true' || query.include_cancelled === '1',
    page: query.page,
    limit: query.limit,
  };
}

router.get('/profitability', requireAuth, requirePermission(PROFITABILITY_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const filters = profitabilityFilters(req.query);
    if (req.query.format === 'csv') {
      const { csv, truncated, sales_orders: exported, total } = await buildProfitabilityCsv(req.user.id, filters);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="profitability-report-${today()}.csv"`);
      // Read by the client to warn that the file is not the whole filtered set. A header rather
      // than a row in the CSV, which would corrupt the data for whatever opens it.
      if (truncated) res.setHeader('X-Report-Truncated', `${exported} of ${total}`);
      return res.send(csv);
    }
    return res.json(await buildProfitabilityReport(req.user.id, filters));
  } catch (err) {
    return next(err);
  }
});

router.get('/profitability/scope', requireAuth, requirePermission(PROFITABILITY_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const scope = await getProfitabilityScope(req.user.id);
    // The user's own office, for the location chip in the header and the Office Location filter's
    // opening value -- the real report opens on where you work, not on every branch at once.
    const defaultLocation = await resolveDefaultLocation(req.user.id);
    return res.json({ ...scope, default_location: defaultLocation });
  } catch (err) {
    return next(err);
  }
});

router.get('/profitability/customers', requireAuth, requirePermission(PROFITABILITY_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    return res.json(await searchProfitabilityCustomers(req.query.q));
  } catch (err) {
    return next(err);
  }
});

router.get('/profitability/line/:lineId', requireAuth, requirePermission(PROFITABILITY_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const detail = await buildProfitabilityLineDetail(req.user.id, Number(req.params.lineId));
    // 404 covers both "no such line" and "not yours to see" on purpose: telling an out-of-scope
    // caller that the line exists is itself the leak the sales scope exists to prevent.
    if (!detail) return res.status(404).json({ error: 'That line is not available.' });
    return res.json(detail);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
