// Department budgets in the accounting manager's workbook format: "2025 ADMIN Expenses vs Budget",
// "2025 Selling Expenses vs Budget" and "2025 COGS vs Budget for Production". See
// db/create-department-budgets.js.
//
// ACTUALS, by month:
//   up to the cut-over (lib/openingBalances booksStart().asOf, 2026-08-31 at the time of writing):
//     the source's own department income statement, loaded into source_dept_actuals. Its
//     Operating Expenses per department reproduce the workbook's Admin/Selling actuals exactly.
//   after it: T1S's ledger (getPostedGlLines), Operating Expenses lines by department_id.
//   COGS (the user's rule, 2026-09-30): Cost of Goods Sold + the Production departments'
//   operating expenses. The workbook's own Jan-Apr and Nov 2025 COGS do not match this or the
//   source (gaps of 113k-1.05M); May-Oct match the source to within a few thousand.
const pool = require('../db');
const { getPostedGlLines } = require('./glImpact');
const { booksStart } = require('./openingBalances');

// The workbook's rows, in its order, by SOURCE department name.
const TEMPLATE = {
  admin: ['Accounting', 'Building & Maintenance', 'Execom', 'Human Resource', 'Logistics', 'Quality Assurance', 'Supply Chain', 'Support', 'Treasury'],
  selling: ['Marketing', 'Design', 'E-Commerce', 'Branch - Ayala', 'Branch-SM_Cebu', 'Sales-1', 'Sales-2', 'Sales-3', 'Sales-4', 'Sales-5'],
};
const GROUP_LABEL = { admin: 'Admin Expenses', selling: 'Selling Expenses', cogs: 'COGS (Production)' };
const isProduction = (name) => /^production/i.test(String(name || '').trim());
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pad2 = (n) => String(n).padStart(2, '0');
const monthEnd = (y, m) => `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;

// Rows for a new department budget: the workbook's departments, each matched to the T1S
// department of the same name where one exists (by letters and digits only, so "Sales-1" finds
// "Sales - 1"), then the COGS row.
async function seedRows(conn, budgetId) {
  const [deps] = await conn.query('SELECT id, name FROM departments');
  const byNorm = new Map(deps.map((d) => [norm(d.name), d.id]));
  let sort = 0;
  for (const grp of ['admin', 'selling']) {
    for (const name of TEMPLATE[grp]) {
      sort += 1;
      await conn.query(
        'INSERT INTO budget_rows (budget_id, grp, label, source_department, department_id, sort) VALUES (?, ?, ?, ?, ?, ?)',
        [budgetId, grp, name, name, byNorm.get(norm(name)) || null, sort]);
    }
  }
  await conn.query(
    "INSERT INTO budget_rows (budget_id, grp, label, source_department, department_id, sort) VALUES (?, 'cogs', 'COGS (Production)', NULL, NULL, ?)",
    [budgetId, sort + 1]);
}

async function loadRows(budgetId, db = pool) {
  const [rows] = await db.query(
    `SELECT r.*, d.name AS department_name FROM budget_rows r LEFT JOIN departments d ON d.id = r.department_id
      WHERE r.budget_id = ? ORDER BY r.sort, r.id`, [budgetId]);
  if (!rows.length) return [];
  const [amts] = await db.query('SELECT row_id, month, amount FROM budget_row_amounts WHERE row_id IN (?)', [rows.map((r) => r.id)]);
  const byRow = new Map();
  for (const a of amts) {
    if (!byRow.has(a.row_id)) byRow.set(a.row_id, new Array(12).fill(0));
    byRow.get(a.row_id)[a.month - 1] = Number(a.amount);
  }
  return rows.map((r) => ({ ...r, pct: r.pct == null ? null : Number(r.pct), amounts: byRow.get(r.id) || new Array(12).fill(0) }));
}

// Actuals per row per month for a fiscal year: Map(row.id -> (number|null)[12]); null = a month
// not yet reached. Also says where each month came from.
async function rowActuals(year, rows) {
  const books = await booksStart();
  const today = new Date().toISOString().slice(0, 10);
  const source = new Array(12).fill(null); // 'source' | 't1s' | null (future)
  for (let m = 1; m <= 12; m += 1) {
    const start = `${year}-${pad2(m)}-01`;
    if (start > today) continue;
    source[m - 1] = books && monthEnd(year, m) <= books.asOf ? 'source' : 't1s';
  }
  const out = new Map(rows.map((r) => [r.id, source.map((s) => (s ? 0 : null))]));

  // Source months.
  if (source.includes('source')) {
    const [src] = await pool.query(
      'SELECT month, source_department, section, amount FROM source_dept_actuals WHERE year = ?', [year]);
    const loaded = new Set(src.map((s) => s.month));
    for (const s of src) {
      if (source[s.month - 1] !== 'source') continue;
      const i = s.month - 1;
      for (const r of rows) {
        const cur = out.get(r.id);
        if (r.grp === 'cogs') {
          if ((s.section === 'cogs' && s.source_department === 'Total')
            || (s.section === 'opex' && isProduction(s.source_department))) cur[i] += Number(s.amount);
        } else if (s.section === 'opex' && s.source_department === r.source_department) {
          cur[i] += Number(s.amount);
        }
      }
    }
    // A source month with nothing loaded is unknown, not zero.
    source.forEach((s, i) => {
      if (s === 'source' && !loaded.has(i + 1)) { source[i] = 'missing'; for (const r of rows) out.get(r.id)[i] = null; }
    });
  }

  // T1S months.
  const t1sMonths = source.map((s, i) => (s === 't1s' ? i + 1 : null)).filter(Boolean);
  if (t1sMonths.length) {
    const [coa] = await pool.query(
      `SELECT coa.account_code, t.account_sub_type FROM chart_of_accounts coa
         JOIN chart_of_account_types t ON t.id = coa.coa_type_id WHERE t.account_type = 'EXPENSE'`);
    const sub = new Map(coa.map((c) => [c.account_code, c.account_sub_type]));
    const [deps] = await pool.query('SELECT id, name FROM departments');
    const production = new Set(deps.filter((d) => isProduction(d.name)).map((d) => Number(d.id)));
    const lines = await getPostedGlLines({
      fromDate: `${year}-${pad2(t1sMonths[0])}-01`, toDate: monthEnd(year, t1sMonths[t1sMonths.length - 1]),
    });
    for (const l of lines) {
      const st = sub.get(l.account_code); if (!st) continue;
      const m = Number(String(l.entry_date instanceof Date ? l.entry_date.toISOString() : l.entry_date).slice(5, 7));
      if (source[m - 1] !== 't1s') continue;
      const amt = (Number(l.debit) || 0) - (Number(l.credit) || 0);
      const opex = st === 'OPERATING EXPENSES';
      const cogs = /^COST OF/.test(st);
      for (const r of rows) {
        const cur = out.get(r.id);
        if (r.grp === 'cogs') {
          if (cogs || (opex && production.has(Number(l.department_id)))) cur[m - 1] += amt;
        } else if (opex && r.department_id && Number(l.department_id) === Number(r.department_id)) {
          cur[m - 1] += amt;
        }
      }
    }
  }
  for (const [k, v] of out) out.set(k, v.map((x) => (x == null ? null : round2(x))));
  return { actuals: out, month_source: source, books_as_of: books?.asOf || null };
}

// The report: three groups, each row with budget and actual per month; variance is Budget - Actual
// exactly as the workbook computes it (positive = under budget).
async function buildReport(budget) {
  const rows = await loadRows(budget.id);
  const { actuals, month_source: monthSource, books_as_of: booksAsOf } = await rowActuals(budget.fiscal_year, rows);
  const groups = ['admin', 'selling', 'cogs'].map((grp) => {
    const gr = rows.filter((r) => r.grp === grp).map((r) => {
      const act = actuals.get(r.id);
      const annualBudget = round2(r.amounts.reduce((s, v) => s + v, 0));
      const annualActual = round2(act.reduce((s, v) => s + (v || 0), 0));
      return {
        id: r.id, label: r.label, department_id: r.department_id, department_name: r.department_name,
        remarks: r.remarks, pct: r.pct, budget: r.amounts.map(round2), actual: act,
        variance: r.amounts.map((b, i) => (act[i] == null ? null : round2(b - act[i]))),
        annual_budget: annualBudget, annual_actual: annualActual, annual_variance: round2(annualBudget - annualActual),
        no_t1s_department: grp !== 'cogs' && !r.department_id,
      };
    });
    const sumAt = (key, i) => round2(gr.reduce((s, r) => s + (r[key][i] || 0), 0));
    const totals = {
      budget: Array.from({ length: 12 }, (_, i) => sumAt('budget', i)),
      actual: Array.from({ length: 12 }, (_, i) => (monthSource[i] && monthSource[i] !== 'missing' ? sumAt('actual', i) : null)),
      annual_budget: round2(gr.reduce((s, r) => s + r.annual_budget, 0)),
      annual_actual: round2(gr.reduce((s, r) => s + r.annual_actual, 0)),
    };
    totals.variance = totals.budget.map((b, i) => (totals.actual[i] == null ? null : round2(b - totals.actual[i])));
    totals.annual_variance = round2(totals.annual_budget - totals.annual_actual);
    return { grp, label: GROUP_LABEL[grp], rows: gr, totals };
  });
  return {
    budget: { id: budget.id, name: budget.name, fiscal_year: budget.fiscal_year, status: budget.status, version: budget.version, sales_target: budget.sales_target == null ? null : Number(budget.sales_target) },
    month_source: monthSource, books_as_of: booksAsOf, groups,
  };
}

module.exports = { TEMPLATE, GROUP_LABEL, seedRows, loadRows, rowActuals, buildReport };
