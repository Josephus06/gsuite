// STP database reads and the scoring run. The rules themselves are in lib/stpScoring.js and
// lib/stp.js (both pure); this file only fetches the rows they need and saves the results.
//
// Scores are NEVER worked out on page load -- AR aging alone takes seconds over every customer.
// They are calculated by the nightly job (index.js, STP_SCORE_JOB=1), by "Recalculate scores",
// and after the scoring settings are saved, and appended to stp_account_scores: every run adds
// a row per account, so the history is kept; pages read each account's latest row.
const pool = require('../db');
const { collectOpenItems } = require('./arAging');
const { businessToday, UTC_OFFSET_MIN } = require('./crmCadence');
const { salesScope } = require('./salesReportScope');
const { userCan } = require('../middleware/auth');
const { computeMetrics, scoreAccount, rowToSettings, settingsToRow, windowStart } = require('./stpScoring');

// Who an invoice belongs to. sales_invoices.customer_id is set on only some invoices; the rest
// reach their customer through the order, estimate or NSSO they bill -- the rule AR aging and the
// reports engine use.
const INVOICE_CUSTOMER = 'COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)';
const INVOICE_JOINS = `LEFT JOIN sales_orders so ON so.id = si.sales_order_id
  LEFT JOIN estimates e ON e.id = si.estimate_id
  LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id`;
const CM_LIVE = "cm.status NOT IN ('cancelled', 'void', 'voided')";

// The customer an account is scored and credited revenue as: its customer, else the customer its
// lead was converted into. NULL = still a prospect. Needs `leads l` joined on a.lead_id.
const ACCOUNT_CUSTOMER = 'COALESCE(a.customer_id, l.converted_customer_id)';

async function loadSettings(conn = pool) {
  const [[row]] = await conn.query('SELECT * FROM stp_scoring_settings WHERE id = 1');
  return rowToSettings(row);
}

async function saveSettings(settings, userId) {
  const row = { ...settingsToRow(settings), updated_by_user_id: userId };
  const cols = Object.keys(row);
  await pool.query(
    `INSERT INTO stp_scoring_settings (id, ${cols.join(', ')}) VALUES (1, ${cols.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
    Object.values(row));
}

// ₱ invoiced (Net of Tax, cancelled left out) per customer between two dates, end exclusive.
async function revenueByCustomer(customerIds, from, toExclusive) {
  const out = new Map();
  const ids = [...new Set(customerIds.filter(Boolean).map(Number))];
  if (!ids.length) return out;
  const [rows] = await pool.query(
    `SELECT ${INVOICE_CUSTOMER} AS customer_id, SUM(COALESCE(si.net_of_tax, 0)) AS revenue
       FROM sales_invoices si ${INVOICE_JOINS}
      WHERE si.status <> 'cancelled' AND si.date_created >= ? AND si.date_created < ?
        AND ${INVOICE_CUSTOMER} IN (?)
      GROUP BY ${INVOICE_CUSTOMER}`,
    [from, toExclusive, ids]);
  for (const r of rows) out.set(Number(r.customer_id), Number(r.revenue));
  return out;
}

const fiscalYearRevenue = (customerIds, year) => revenueByCustomer(customerIds, `${year}-01-01`, `${Number(year) + 1}-01-01`);

// Latest completed CRM visit per customer, as a business-clock date.
async function lastCrmVisits(customerIds) {
  const out = new Map();
  const ids = [...new Set(customerIds.filter(Boolean).map(Number))];
  if (!ids.length) return out;
  const [rows] = await pool.query(
    `SELECT related_id AS customer_id,
            MAX(DATE(DATE_ADD(COALESCE(completed_at, starts_at, due_date), INTERVAL ? MINUTE))) AS last_visit
       FROM crm_activities
      WHERE related_type = 'Customer' AND activity_type = 'visit' AND is_done = TRUE AND related_id IN (?)
      GROUP BY related_id`,
    [UTC_OFFSET_MIN, ids]);
  for (const r of rows) if (r.last_visit) out.set(Number(r.customer_id), String(r.last_visit).slice(0, 10));
  return out;
}

// The credit term on the customer's latest invoice -- customers.payment_term_id is empty for every
// customer, so the invoices are where the terms actually live.
async function latestInvoiceTerm(customerId) {
  if (!customerId) return null;
  const [[row]] = await pool.query(
    `SELECT si.term, DATEDIFF(si.date_due, si.date_created) AS days
       FROM sales_invoices si ${INVOICE_JOINS}
      WHERE si.status <> 'cancelled' AND ${INVOICE_CUSTOMER} = ?
      ORDER BY si.date_created DESC, si.id DESC LIMIT 1`, [customerId]);
  if (!row) return null;
  return row.term || (row.days > 0 ? `${row.days} days` : 'Cash / on delivery');
}

const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    const k = Number(r[key]);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};

// The raw rows computeMetrics needs, for many customers at once.
async function loadScoringRows(customerIds, asOf) {
  const ids = [...new Set(customerIds.filter(Boolean).map(Number))];
  const empty = new Map();
  if (!ids.length) return { invoices: empty, creditMemos: empty, payments: empty, creditApps: empty, openItems: empty };

  const [invoices] = await pool.query(
    `SELECT si.id, ${INVOICE_CUSTOMER} AS customer_id, si.date_created, si.date_due, si.net_of_tax, si.amount_due
       FROM sales_invoices si ${INVOICE_JOINS}
      WHERE si.status <> 'cancelled' AND si.date_created <= ? AND ${INVOICE_CUSTOMER} IN (?)`,
    [asOf, ids]);
  const [creditMemos] = await pool.query(
    `SELECT cm.customer_id, cm.sales_invoice_id, cm.date_created, cm.net_of_tax, cm.gross_amount
       FROM credit_memos cm WHERE ${CM_LIVE} AND cm.date_created <= ? AND cm.customer_id IN (?)`,
    [asOf, ids]);

  const customerOfInvoice = new Map(invoices.map((i) => [Number(i.id), Number(i.customer_id)]));
  let payments = [];
  if (invoices.length) {
    const [rows] = await pool.query(
      `SELECT cpl.sales_invoice_id, cp.customer_payment_no AS payment_no, cp.date_created AS payment_date, cpl.applied_amount
         FROM customer_payment_lines cpl
         JOIN customer_payments cp ON cp.id = cpl.customer_payment_id AND cp.voided_at IS NULL
        WHERE cpl.sales_invoice_id IN (?) AND cp.date_created <= ?`,
      [invoices.map((i) => i.id), asOf]);
    payments = rows.map((p) => ({ ...p, customer_id: customerOfInvoice.get(Number(p.sales_invoice_id)) }));
  }
  const creditApps = creditMemos.filter((c) => c.sales_invoice_id)
    .map((c) => ({ customer_id: c.customer_id, sales_invoice_id: c.sales_invoice_id, date_created: c.date_created, amount: c.gross_amount }));

  // AR aging is the source of truth for what is still owed. It is built for every customer at
  // once, so it runs once per scoring run, not once per account.
  const wanted = new Set(ids);
  const openItems = (await collectOpenItems(asOf)).filter((i) => wanted.has(Number(i.customer_id)));

  return {
    invoices: groupBy(invoices, 'customer_id'),
    creditMemos: groupBy(creditMemos, 'customer_id'),
    payments: groupBy(payments, 'customer_id'),
    creditApps: groupBy(creditApps, 'customer_id'),
    openItems: groupBy(openItems, 'customer_id'),
  };
}

let running = null;

// Score every account, every fiscal year (a customer's behaviour does not depend on which plan it
// sits in), as of asOf, appending one stp_account_scores row each. One run at a time: a request
// made while one is in progress gets that run's result.
function recalculateScores({ asOf = businessToday(), userId = null } = {}) {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    const settings = await loadSettings();
    const [accounts] = await pool.query(
      `SELECT a.id, ${ACCOUNT_CUSTOMER} AS customer_id FROM stp_accounts a LEFT JOIN leads l ON l.id = a.lead_id`);
    const rows = await loadScoringRows(accounts.map((a) => a.customer_id), asOf);
    const pick = (map, cid) => (cid ? map.get(Number(cid)) || [] : []);

    const values = [];
    let prospects = 0;
    for (const a of accounts) {
      const metrics = a.customer_id ? computeMetrics({
        invoices: pick(rows.invoices, a.customer_id),
        creditMemos: pick(rows.creditMemos, a.customer_id),
        payments: pick(rows.payments, a.customer_id),
        creditApps: pick(rows.creditApps, a.customer_id),
        openItems: pick(rows.openItems, a.customer_id),
      }, asOf, settings.window_months) : null;
      const r = scoreAccount(metrics, settings);
      if (r.is_prospect) prospects += 1;
      const m = metrics || {};
      const sc = r.scores || {};
      values.push([
        a.id, m.period_start || null, asOf, settings.window_months, r.is_prospect, m.last_invoice_date || null,
        m.days_since_last_order ?? null, m.order_count ?? null, m.net_volume ?? null, m.avg_days_to_pay ?? null,
        m.avg_days_late ?? null, m.pct_on_time ?? null, m.overdue_balance ?? null,
        m.overdue_pct == null ? null : Math.min(m.overdue_pct, 99999999),
        sc.recency ?? null, sc.frequency ?? null, sc.volume ?? null, sc.character ?? null, r.character_source,
        r.total, r.tier, r.warnings.join(',') || null, userId,
      ]);
    }
    // period_start is the window's first day even for a prospect (it has no metrics to carry it).
    const start = windowStart(asOf, settings.window_months);
    for (const v of values) if (!v[1]) v[1] = start;
    for (let i = 0; i < values.length; i += 500) {
      await pool.query(
        `INSERT INTO stp_account_scores
           (account_id, period_start, period_end, window_months, is_prospect, last_invoice_date, days_since_last_order,
            order_count, net_volume, avg_days_to_pay, avg_days_late, pct_on_time, overdue_balance, overdue_pct,
            recency_score, frequency_score, volume_score, character_score, character_source, total_score, computed_tier,
            warnings, calculated_by_user_id)
         VALUES ?`, [values.slice(i, i + 500)]);
    }
    return { as_of: asOf, accounts: accounts.length, scored: accounts.length - prospects, prospects, ms: Date.now() - started };
  })().finally(() => { running = null; });
  return running;
}

function stpScoreJobEnabled() {
  return process.env.STP_SCORE_JOB === '1';
}

// Whose territories and accounts a user sees -- the Sales reports' rule (lib/salesReportScope.js):
// an account officer their own, a supervisor / SBU head their team's, everyone else all of them.
// STP Admins see everything. Returns null for "everything", else the rep user ids visible.
async function visibleRepIds(userId) {
  if (await userCan(userId, '/stp', 'can_delete')) return null;
  const scope = await salesScope(userId);
  if (scope.kind === 'all') return null;
  const ids = new Set([Number(userId)]);
  const team = scope.team || [];
  if (team.length) {
    const [users] = await pool.query('SELECT id FROM users WHERE employee_id IN (?)', [team]);
    users.forEach((u) => ids.add(Number(u.id)));
  }
  return [...ids];
}

module.exports = {
  INVOICE_CUSTOMER, INVOICE_JOINS, ACCOUNT_CUSTOMER,
  loadSettings, saveSettings, revenueByCustomer, fiscalYearRevenue, lastCrmVisits, latestInvoiceTerm, loadScoringRows,
  recalculateScores, stpScoreJobEnabled, visibleRepIds,
};
