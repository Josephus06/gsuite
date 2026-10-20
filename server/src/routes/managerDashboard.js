const express = require('express');
const mysql = require('mysql2/promise');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { buildArAging } = require('../lib/arAging');
const { grossDueSql } = require('../lib/invoiceDue');

// Managers Dashboard (asked 2026-10-20): the read-only figures behind the "Managers Dashboard"
// Android app -- AR aging, sales orders, invoices and collections. GET only; nothing here writes.
// Each metric counts what its ERP page shows (asked 2026-10-20), and says which page that is:
//   AR Aging     Reports > AR Aging     /reports/ar-aging   (its own report code)
//   Invoices     Saved Invoices         /sales-invoices     (Status, Amount Due on gross)
//   Collection   Customer Payments      /customer-payments  (every payment but a voided one)
//   Sales        Sales Orders           /sales-orders       (Total Amount, by status tab)
// Only users given View on the "Managers Dashboard" page (/manager-dashboard) may call it; they sign
// in through the ERP's own POST /api/auth/login and send its token.
//
//   GET /api/manager/overview          the four headline figures, for the KPI tiles
//   GET /api/manager/ar-aging          buckets as of today, and customers by oldest balance
//   GET /api/manager/weighted-sales    Sales Orders created in the period, by status
//   GET /api/manager/invoices-summary  invoices dated in the period: Paid / Partially paid / Unpaid / Overdue
//   GET /api/manager/collections       real customer payments in the period vs the monthly target
// Each takes ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive; default month to date, Philippine time).
//
// Its own SQL runs on a SELECT-only MySQL account when MANAGER_DB_USER / MANAGER_DB_PASSWORD are set
// (same host and database as the ERP). AR aging reuses the ERP's own report (lib/arAging.js) so the
// app always agrees with Accounting > Reports > AR Aging; that code only reads, on the ERP's pool.
const ROUTE = '/manager-dashboard';
const router = express.Router();

const ro = process.env.MANAGER_DB_USER
  ? mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.MANAGER_DB_USER,
    password: process.env.MANAGER_DB_PASSWORD || '',
    database: process.env.DB_NAME || 'gsuite_erp',
    waitForConnections: true,
    connectionLimit: 4,
    decimalNumbers: true,
    dateStrings: true,
  })
  : pool;

// Only reads, whatever the method.
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  return res.status(405).json({ error: 'The Managers Dashboard API is read-only.' });
});
router.use(requireAuth, requirePermission(ROUTE, 'can_view'));

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
// Today in the Philippines -- the ERP's sessions run in UTC (db.js).
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// ?from / ?to, inclusive. Default: the 1st of this month to today. At most 366 days.
function period(req) {
  const today = manilaToday();
  const to = req.query.to || today;
  const from = req.query.from || `${to.slice(0, 7)}-01`;
  if (!ISO.test(from) || !ISO.test(to)) { const e = new Error('from and to must be YYYY-MM-DD.'); e.status = 400; throw e; }
  if (from > to) { const e = new Error('from must not be after to.'); e.status = 400; throw e; }
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) { const e = new Error('The period may be at most 366 days.'); e.status = 400; throw e; }
  return { from, to, today };
}

function handle(fn) {
  return async (req, res, next) => {
    try {
      res.json({ ...(await fn(req)), generated_at: new Date().toISOString() });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      return next(err);
    }
  };
}

/* ------------------------------------------------------------------ AR aging ---------------- */

const BUCKETS = [
  { key: 'current', label: 'Current' },
  { key: 'd1_30', label: '1-30' },
  { key: 'd31_60', label: '31-60' },
  { key: 'd61_90', label: '61-90' },
  { key: 'over_90', label: '90+' },
];

// The report takes a few seconds over the whole ledger; a manager pulling to refresh twice in a
// minute gets the same answer. Two minutes, per as-of date.
const AGING_TTL_MS = 2 * 60 * 1000;
const agingCache = new Map();
async function agingAsOf(asOf) {
  const hit = agingCache.get(asOf);
  if (hit && Date.now() - hit.at < AGING_TTL_MS) return hit.data;
  const data = await buildArAging(asOf);
  agingCache.clear();
  agingCache.set(asOf, { at: Date.now(), data });
  return data;
}

function agingBuckets(totals) {
  const total = round2(totals.total_balance);
  return BUCKETS.map((b) => ({
    key: b.key, label: b.label, amount: round2(totals[b.key]),
    pct: total ? round2((totals[b.key] / total) * 100) : 0,
  }));
}

// Oldest first: the most in 90+, then 61-90, and so on. With a bucket chosen, only customers owing
// in it, largest first.
function oldestFirst(a, b) {
  for (const k of ['over_90', 'd61_90', 'd31_60', 'd1_30', 'current']) {
    if (Math.abs(b[k] - a[k]) >= 0.005) return b[k] - a[k];
  }
  return 0;
}

router.get('/ar-aging', handle(async (req) => {
  const { today } = period(req);
  const bucket = req.query.bucket ? String(req.query.bucket) : null;
  if (bucket && !BUCKETS.some((b) => b.key === bucket)) {
    const e = new Error(`bucket must be one of ${BUCKETS.map((b) => b.key).join(', ')}.`); e.status = 400; throw e;
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const aging = await agingAsOf(today);
  let rows = aging.rows.filter((r) => r.total_balance > 0.005);
  rows = bucket
    ? rows.filter((r) => r[bucket] > 0.005).sort((a, b) => b[bucket] - a[bucket])
    : rows.sort(oldestFirst);
  return {
    as_of: today,
    source_page: '/reports/ar-aging',
    total_outstanding: round2(aging.totals.total_balance),
    buckets: agingBuckets(aging.totals),
    customer_count: rows.length,
    customers: rows.slice(0, limit).map((r) => ({
      customer_id: r.customer_id, customer_name: r.customer_name,
      current: r.current, d1_30: r.d1_30, d31_60: r.d31_60, d61_90: r.d61_90, over_90: r.over_90,
      total_balance: r.total_balance,
    })),
  };
}));

/* ------------------------------------------------------------------ Sales Orders ------------ */

// "Weighted Sales" on the app is every Sales Order created in the period (asked 2026-10-20: "all
// SALES order created this month not estimate"), by where it has got to. Cancelled ones are left out.
// The Sales Orders page's own status tabs, in its order (client/src/pages/SalesOrders.jsx).
const SO_STAGES = [
  ['pending_for_jo', 'Pending for JO'],
  ['jo_in_process', 'JO In-Process'],
  ['pending_delivery', 'Pending Delivery'],
  ['partially_delivered', 'Partially Delivered'],
  ['pending_billing', 'Pending Billing'],
  ['pending_billing_partially_delivered', 'Pending Billing / Partially Delivered'],
  ['partially_billed', 'Partially Billed'],
  ['billed', 'Billed'],
];

async function salesOrders(from, to) {
  const [rows] = await ro.query(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(total_amount), 0) AS amount, COALESCE(SUM(net_of_tax), 0) AS net
       FROM sales_orders
      WHERE date_created >= ? AND date_created <= ?
      GROUP BY status`, [from, to]);
  const cancelled = rows.find((r) => r.status === 'cancelled');
  const by = new Map(rows.filter((r) => r.status !== 'cancelled').map((r) => [r.status, r]));
  const stages = SO_STAGES.map(([key, label]) => ({
    key, label, count: Number(by.get(key)?.n || 0), amount: round2(by.get(key)?.amount), net_of_tax: round2(by.get(key)?.net),
  }));
  // Any status not listed above still counts, under its own name.
  for (const r of rows) {
    if (r.status !== 'cancelled' && !SO_STAGES.some(([k]) => k === r.status)) {
      stages.push({ key: r.status, label: String(r.status || 'Unknown'), count: Number(r.n), amount: round2(r.amount), net_of_tax: round2(r.net) });
    }
  }
  return {
    total_amount: round2(stages.reduce((s, x) => s + x.amount, 0)),
    total_net_of_tax: round2(stages.reduce((s, x) => s + x.net_of_tax, 0)),
    count: stages.reduce((s, x) => s + x.count, 0),
    stages: stages.filter((s) => s.count > 0),
    cancelled: { count: Number(cancelled?.n || 0), amount: round2(cancelled?.amount) },
  };
}

router.get('/weighted-sales', handle(async (req) => {
  const { from, to } = period(req);
  return { from, to, basis: 'sales_orders_created', source_page: '/sales-orders', ...(await salesOrders(from, to)) };
}));

/* ------------------------------------------------------------------ Invoices ---------------- */

// As the Saved Invoices page (/sales-invoices) shows them: its Status (Open / Paid In Full / Void)
// and its Amount Due (on gross -- lib/invoiceDue.js). The app's four, from those:
//   Paid            Status Paid In Full
//   Overdue         Open and past its Date Due (wins over the two below, so each counts once)
//   Partially paid  Open, not yet due, Amount Due below the Gross Amount
//   Unpaid          Open, not yet due, Amount Due = Gross Amount
// Void invoices are reported apart and left out of the totals.
const INVOICE_STATUSES = [['paid', 'Paid'], ['partial', 'Partially paid'], ['unpaid', 'Unpaid'], ['overdue', 'Overdue']];

async function invoices(from, to, today) {
  const [rows] = await ro.query(
    `SELECT bucket, COUNT(*) AS n, COALESCE(SUM(gross), 0) AS gross, COALESCE(SUM(due), 0) AS due
       FROM (SELECT si.gross_amount AS gross, ${grossDueSql('si')} AS due,
                    CASE
                      WHEN si.status = 'cancelled' THEN 'void'
                      WHEN si.status = 'paid_in_full' THEN 'paid'
                      WHEN COALESCE(si.date_due, si.date_created) < ? THEN 'overdue'
                      WHEN ${grossDueSql('si')} < si.gross_amount - 0.005 THEN 'partial'
                      ELSE 'unpaid'
                    END AS bucket
               FROM sales_invoices si
              WHERE si.date_created >= ? AND si.date_created <= ?) x
      GROUP BY bucket`, [today, from, to]);
  const by = new Map(rows.map((r) => [r.bucket, r]));
  const voided = by.get('void');
  const statuses = INVOICE_STATUSES.map(([key, label]) => ({
    key, label, count: Number(by.get(key)?.n || 0), amount: round2(by.get(key)?.gross), outstanding: round2(by.get(key)?.due),
  }));
  return {
    count: statuses.reduce((s, x) => s + x.count, 0),
    total_amount: round2(statuses.reduce((s, x) => s + x.amount, 0)),
    total_outstanding: round2(statuses.reduce((s, x) => s + x.outstanding, 0)),
    statuses,
    void: { count: Number(voided?.n || 0), amount: round2(voided?.gross) },
  };
}

router.get('/invoices-summary', handle(async (req) => {
  const { from, to, today } = period(req);
  return { from, to, source_page: '/sales-invoices', ...(await invoices(from, to, today)) };
}));

/* ------------------------------------------------------------------ Collections ------------- */

// Every Customer Payment the Customer Payments page (/customer-payments) lists for the dates, except a
// voided one -- Payment Amount, by Date. That page lists the CPAY-INV-#### payments generated to close
// imported invoices as well, so they count here too; how much of the total they are is returned
// (generated) so the app can say so. The target is Treasury's monthly target (Treasury > Collection
// Incentive set-up, collection_incentive_settings), times the months the period touches.
const REAL_PAYMENT = "cp.status <> 'voided'";
const MODES = [['check', 'Check'], ['bank_transfer', 'Bank transfer'], ['cash', 'Cash'], ['gcash', 'GCash'], ['other', 'Other']];
function modeOf(name) {
  const n = String(name || '').toUpperCase();
  if (n.includes('CHECK') || n.includes('CHEQUE')) return 'check';
  if (n.includes('GCASH')) return 'gcash';
  if (n === 'CASH') return 'cash';
  if (n.includes('ONLINE') || n.includes('DEPOSIT') || n.includes('OTC') || n.includes('BANK') || n.includes('TRANSFER')) return 'bank_transfer';
  return 'other';
}

async function monthlyTarget(year) {
  const [[row]] = await ro.query(
    'SELECT monthly_target FROM collection_incentive_settings WHERE year <= ? ORDER BY year DESC LIMIT 1', [year])
    .catch((e) => { if (e.code === 'ER_NO_SUCH_TABLE') return [[null]]; throw e; });
  return row ? Number(row.monthly_target) : null;
}

async function collections(from, to) {
  const [[tot]] = await ro.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(cp.payment_amount), 0) AS amount,
            COALESCE(SUM(cp.status = 'deposited'), 0) AS dep_n,
            COALESCE(SUM(IF(cp.status = 'deposited', cp.payment_amount, 0)), 0) AS dep_amount,
            COALESCE(SUM(cp.customer_payment_no LIKE 'CPAY-INV-%'), 0) AS gen_n,
            COALESCE(SUM(IF(cp.customer_payment_no LIKE 'CPAY-INV-%', cp.payment_amount, 0)), 0) AS gen_amount
       FROM customer_payments cp
      WHERE ${REAL_PAYMENT} AND cp.date_created >= ? AND cp.date_created < ?`, [from, addDays(to, 1)]);
  const [methods] = await ro.query(
    `SELECT pm.name, COUNT(*) AS n, COALESCE(SUM(cp.payment_amount), 0) AS amount
       FROM customer_payments cp LEFT JOIN payment_methods pm ON pm.id = cp.payment_method_id
      WHERE ${REAL_PAYMENT} AND cp.date_created >= ? AND cp.date_created < ?
      GROUP BY pm.name`, [from, addDays(to, 1)]);
  const sevenFrom = addDays(to, -6);
  const [days] = await ro.query(
    `SELECT DATE_FORMAT(cp.date_created, '%Y-%m-%d') AS d, COALESCE(SUM(cp.payment_amount), 0) AS amount
       FROM customer_payments cp
      WHERE ${REAL_PAYMENT} AND cp.date_created >= ? AND cp.date_created < ?
      GROUP BY d`, [sevenFrom, addDays(to, 1)]);

  const modeTotals = new Map(MODES.map(([k]) => [k, { amount: 0, count: 0, methods: [] }]));
  for (const m of methods) {
    const t = modeTotals.get(modeOf(m.name));
    t.amount += Number(m.amount); t.count += Number(m.n); t.methods.push(m.name || 'Not set');
  }
  const total = round2(tot.amount);
  const dayMap = new Map(days.map((r) => [r.d, round2(r.amount)]));

  // The months the period touches, each at its own year's target.
  let target = 0; let targetKnown = true;
  for (let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7)); `${y}-${String(m).padStart(2, '0')}` <= to.slice(0, 7); m === 12 ? (y += 1, m = 1) : (m += 1)) {
    const t = await monthlyTarget(y);
    if (t == null) { targetKnown = false; break; }
    target += t;
  }
  return {
    total_collected: total,
    payment_count: Number(tot.n),
    deposited: { count: Number(tot.dep_n), amount: round2(tot.dep_amount) },
    not_deposited: { count: Number(tot.n) - Number(tot.dep_n), amount: round2(total - Number(tot.dep_amount)) },
    generated: { count: Number(tot.gen_n), amount: round2(tot.gen_amount) },
    target: targetKnown ? round2(target) : null,
    pct_achieved: targetKnown && target ? round2((total / target) * 100) : null,
    last_7_days: Array.from({ length: 7 }, (_, i) => { const d = addDays(sevenFrom, i); return { date: d, amount: dayMap.get(d) || 0 }; }),
    by_mode: MODES.map(([key, label]) => {
      const t = modeTotals.get(key);
      return { key, label, amount: round2(t.amount), count: t.count, pct: total ? round2((t.amount / total) * 100) : 0, methods: t.methods };
    }),
  };
}

router.get('/collections', handle(async (req) => {
  const { from, to } = period(req);
  return { from, to, source_page: '/customer-payments', ...(await collections(from, to)) };
}));

/* ------------------------------------------------------------------ Overview ---------------- */

// The four tiles in one call.
router.get('/overview', handle(async (req) => {
  const { from, to, today } = period(req);
  const [aging, so, inv, col] = await Promise.all([agingAsOf(today), salesOrders(from, to), invoices(from, to, today), collections(from, to)]);
  return {
    from, to, as_of: today,
    ar_outstanding: round2(aging.totals.total_balance),
    ar_over_90: round2(aging.totals.over_90),
    sales_orders: { total_amount: so.total_amount, count: so.count },
    invoices: { total_amount: inv.total_amount, count: inv.count, overdue_count: inv.statuses.find((s) => s.key === 'overdue').count },
    collections: { total_collected: col.total_collected, target: col.target, pct_achieved: col.pct_achieved },
  };
}));

module.exports = router;
