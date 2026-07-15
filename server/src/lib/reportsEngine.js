const pool = require('../db');
const { getPostedGlLines } = require('./glImpact');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function yearStart(dateStr) {
  return `${String(dateStr).slice(0, 4)}-01-01`;
}

// Loads the full Chart of Accounts once, joined to chart_of_account_types for the
// account_type / account_sub_type / normal_balance grouping the real system's reports
// use (matches ASSET/LIABILITY/EQUITY/INCOME/EXPENSE + their sub_types exactly).
// Deliberately NOT filtered by is_active: this build's migrated COA data has that flag
// set to 0 on core, actively-posted accounts (Accounts Receivable Trade, Sales,
// Accounts Payable - Trade, VAT on Sales, Inventory In Transit all check in as
// is_active=0) -- it doesn't reliably mean "unusable" here, and excluding those
// accounts would silently drop real GL lines out of every report's totals.
async function loadCoa() {
  const [rows] = await pool.query(
    `SELECT coa.id, coa.account_code, coa.account_name, coa.parent_account_id, coa.is_summary, coa.coa_type_id,
            t.account_type, t.account_sub_type, t.normal_balance
     FROM chart_of_accounts coa
     LEFT JOIN chart_of_account_types t ON t.id = coa.coa_type_id
     ORDER BY coa.account_code`
  );
  return rows;
}

// Nets every posted GL line (debit - credit, raw signed) per account_code. This raw
// figure is additive regardless of an account's normal side, which is what makes the
// parent/child rollup below correct: a subtree's total is just the sum of its raw
// signed balances, and the normal-side sign flip (for display only) is applied once,
// after rollup, using the root's own normal_balance.
function netBalancesByCode(glLines) {
  const balances = new Map();
  for (const l of glLines) {
    const prev = balances.get(l.account_code) || 0;
    balances.set(l.account_code, prev + (Number(l.debit) || 0) - (Number(l.credit) || 0));
  }
  return balances;
}

// Builds the parent/child COA tree (mirrors chart_of_accounts.parent_account_id),
// attaching each node's own net raw balance and recursively rolling children's
// balances into their parents -- the same "summary account = sum of its children"
// rule confirmed against the real system's Trial Balance/Balance Sheet payloads.
function buildTree(coaRows, balances) {
  const byId = new Map(coaRows.map((c) => [c.id, {
    ...c, children: [], rawAmount: balances.get(c.account_code) || 0,
  }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_account_id && byId.has(node.parent_account_id)) {
      byId.get(node.parent_account_id).children.push(node);
    } else if (!node.parent_account_id) {
      roots.push(node);
    }
  }
  function rollup(node) {
    let sum = node.rawAmount;
    for (const c of node.children) sum += rollup(c);
    node.rawAmount = sum;
    return sum;
  }
  roots.forEach(rollup);
  return roots;
}

function serializeNode(node, sign) {
  return {
    account_code: node.account_code,
    account_name: node.account_name,
    is_summary: !!node.is_summary,
    amount: round2(node.rawAmount * sign),
    children: node.children.map((c) => serializeNode(c, sign)),
  };
}

// Groups root (top-level, no parent) accounts into normal_balance -> account_type ->
// account_sub_type buckets -- the same 3-level grouping the real Trial Balance/Balance
// Sheet responses use. `typeFilter`, when given, keeps only those account_types
// (Balance Sheet excludes INCOME/EXPENSE; Trial Balance keeps everything).
function groupRoots(roots, { typeFilter } = {}) {
  const byNormal = new Map();
  for (const root of roots) {
    if (!root.account_type || !root.normal_balance) continue;
    if (typeFilter && !typeFilter.includes(root.account_type)) continue;
    const sign = root.normal_balance === 'CREDIT' ? -1 : 1;
    if (!byNormal.has(root.normal_balance)) byNormal.set(root.normal_balance, new Map());
    const byType = byNormal.get(root.normal_balance);
    if (!byType.has(root.account_type)) byType.set(root.account_type, new Map());
    const bySub = byType.get(root.account_type);
    const subKey = root.account_sub_type || 'OTHER';
    if (!bySub.has(subKey)) bySub.set(subKey, []);
    bySub.get(subKey).push(serializeNode(root, sign));
  }

  const data = [];
  let debitTotal = 0;
  let creditTotal = 0;
  for (const [normal, byType] of byNormal) {
    for (const [type, bySub] of byType) {
      const accounts = [];
      for (const [subType, ledgers] of bySub) {
        accounts.push({ sub_type: subType, account_ledgers: ledgers });
        const subTotal = ledgers.reduce((s, l) => s + l.amount, 0);
        if (normal === 'DEBIT') debitTotal += subTotal; else creditTotal += subTotal;
      }
      data.push({ normal, type, accounts });
    }
  }
  return { data, debitTotal: round2(debitTotal), creditTotal: round2(creditTotal) };
}

// Trial Balance: every account type, "as of" a single cutoff date. `balanced` is the
// core correctness check for this whole GL Impact + Reports effort -- it can only be
// true if every one of the 8 transaction types' GL postings are genuinely double-entry.
async function buildTrialBalance(asOfDate) {
  const [coaRows, glLines] = await Promise.all([loadCoa(), getPostedGlLines({ toDate: asOfDate })]);
  const balances = netBalancesByCode(glLines);
  const roots = buildTree(coaRows, balances);
  const { data, debitTotal, creditTotal } = groupRoots(roots);
  return {
    as_of: asOfDate, data, debit_total: debitTotal, credit_total: creditTotal,
    balanced: Math.abs(debitTotal - creditTotal) < 0.01,
  };
}

// Balance Sheet: ASSET/LIABILITY/EQUITY only, same "as of" point-in-time semantics as
// Trial Balance, plus a synthetic "Current Earnings" line under Equity (cumulative
// INCOME - cumulative EXPENSE to date) -- this build has no formal period-closing
// entries, so without this line the sheet would never actually balance. Documented
// simplification, not a real posted account.
async function buildBalanceSheet(asOfDate) {
  const [coaRows, glLines] = await Promise.all([loadCoa(), getPostedGlLines({ toDate: asOfDate })]);
  const balances = netBalancesByCode(glLines);
  const roots = buildTree(coaRows, balances);

  let incomeTotal = 0;
  let expenseTotal = 0;
  for (const root of roots) {
    if (root.account_type === 'INCOME') incomeTotal += root.rawAmount * -1;
    if (root.account_type === 'EXPENSE') expenseTotal += root.rawAmount * 1;
  }
  const currentEarnings = round2(incomeTotal - expenseTotal);

  const { data, debitTotal, creditTotal } = groupRoots(roots, { typeFilter: ['ASSET', 'LIABILITY', 'EQUITY'] });
  const equityBucket = data.find((d) => d.type === 'EQUITY');
  const earningsNode = {
    account_code: 'CURRENT-EARNINGS', account_name: 'Current Earnings (Unclosed)',
    is_summary: false, amount: currentEarnings, children: [],
  };
  if (equityBucket) {
    if (!equityBucket.accounts.length) equityBucket.accounts.push({ sub_type: 'EQUITIES', account_ledgers: [] });
    equityBucket.accounts[0].account_ledgers.push(earningsNode);
  } else {
    data.push({ normal: 'CREDIT', type: 'EQUITY', accounts: [{ sub_type: 'EQUITIES', account_ledgers: [earningsNode] }] });
  }
  const finalCreditTotal = round2(creditTotal + currentEarnings);

  return {
    as_of: asOfDate, data,
    asset_total: debitTotal, liability_equity_total: finalCreditTotal,
    current_earnings: currentEarnings,
    balanced: Math.abs(debitTotal - finalCreditTotal) < 0.01,
  };
}

const INCOME_SECTION_ORDER = ['REVENUES', 'OTHER INCOME'];
const EXPENSE_SECTION_ORDER = ['COST OF GOOD SOLDS', 'COST OF SERVICES', 'OPERATING EXPENSES', 'NON-OPERATING EXPENSES', 'OTHER EXPENSE', 'EXPENSE'];

// Multi-column variants of buildTree/serializeNode/section-grouping, used only by
// Income Statement's breakdown modes (Months/Location/Department) -- Trial
// Balance/Balance Sheet/General Ledger stay single-column via the originals above.
// Each node carries one raw amount per column/partition instead of a single number,
// rolled up in parallel so every column shares the exact same account tree/ordering.
function buildTreeMulti(coaRows, balanceMaps) {
  const byId = new Map(coaRows.map((c) => [c.id, {
    ...c, children: [], rawAmounts: balanceMaps.map((m) => m.get(c.account_code) || 0),
  }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_account_id && byId.has(node.parent_account_id)) {
      byId.get(node.parent_account_id).children.push(node);
    } else if (!node.parent_account_id) {
      roots.push(node);
    }
  }
  function rollup(node) {
    let sums = node.rawAmounts.slice();
    for (const c of node.children) {
      const childSums = rollup(c);
      sums = sums.map((s, i) => s + childSums[i]);
    }
    node.rawAmounts = sums;
    return sums;
  }
  roots.forEach(rollup);
  return roots;
}

function serializeNodeMulti(node, sign) {
  return {
    account_code: node.account_code,
    account_name: node.account_name,
    is_summary: !!node.is_summary,
    amounts: node.rawAmounts.map((a) => round2(a * sign)),
    children: node.children.map((c) => serializeNodeMulti(c, sign)),
  };
}

function buildIncomeSectionMulti(roots, accountType, sectionOrder, sign, numCols) {
  const bySub = new Map();
  for (const root of roots) {
    if (root.account_type !== accountType || !root.account_sub_type) continue;
    if (!bySub.has(root.account_sub_type)) bySub.set(root.account_sub_type, []);
    bySub.get(root.account_sub_type).push(serializeNodeMulti(root, sign));
  }
  const sections = [];
  const totals = new Array(numCols).fill(0);
  const order = [...sectionOrder, ...[...bySub.keys()].filter((k) => !sectionOrder.includes(k))];
  for (const subType of order) {
    const accounts = bySub.get(subType);
    if (!accounts || !accounts.length) continue;
    const subtotals = new Array(numCols).fill(0);
    for (const a of accounts) a.amounts.forEach((v, i) => { subtotals[i] += v; });
    const subtotalsRounded = subtotals.map(round2);
    sections.push({ sub_type: subType, accounts, subtotals: subtotalsRounded });
    subtotalsRounded.forEach((v, i) => { totals[i] += v; });
  }
  return { sections, totals: totals.map(round2) };
}

// Splits the period's GL lines into the columns for a given breakdown mode -- 'total'
// (the default, one column), 'months' (one column per calendar month spanned by the
// period), 'location'/'department' (one column per distinct value seen on the
// transactions themselves, plus an "Unassigned" column for lines with no value --
// Inventory Adjustment's location/department is approximated from its first line since
// this build's GL lines are posted per-transaction, not per-line; see glImpact.js).
function partitionGlLines(glLines, breakdown, fromDate, asOfDate) {
  if (breakdown === 'months') {
    const start = new Date(fromDate);
    const end = new Date(asOfDate);
    const months = [];
    let cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur <= end) {
      const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
      const label = cur.toLocaleString('en-US', { month: 'short', year: 'numeric' });
      months.push({ key, label, lines: [] });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    const byKey = new Map(months.map((m) => [m.key, m]));
    for (const l of glLines) {
      const d = new Date(l.entry_date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (byKey.has(key)) byKey.get(key).lines.push(l);
    }
    return months;
  }
  if (breakdown === 'location' || breakdown === 'department') {
    const field = breakdown === 'location' ? 'location_id' : 'department_id';
    const groups = new Map();
    for (const l of glLines) {
      const key = l[field] ? String(l[field]) : 'unassigned';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l);
    }
    return [...groups.entries()].map(([key, lines]) => ({ key, label: null, lines }));
  }
  return [{ key: 'total', label: 'Total', lines: glLines }];
}

async function resolvePartitionLabels(partitions, breakdown) {
  const table = breakdown === 'location' ? 'locations' : 'departments';
  const nameCol = breakdown === 'location' ? 'location_name' : 'name';
  const ids = partitions.map((p) => p.key).filter((k) => k !== 'unassigned');
  let names = new Map();
  if (ids.length) {
    const [rows] = await pool.query(`SELECT id, ${nameCol} AS name FROM ${table} WHERE id IN (?)`, [ids]);
    names = new Map(rows.map((r) => [String(r.id), r.name]));
  }
  const labeled = partitions.map((p) => ({ ...p, label: p.key === 'unassigned' ? 'Unassigned' : (names.get(p.key) || `#${p.key}`) }));
  labeled.sort((a, b) => a.label.localeCompare(b.label));
  return labeled;
}

// Income Statement: a period report (flow, not point-in-time) -- the real UI's single
// "as of" date defaults to a calendar-year-to-date period (Jan 1 through that date).
// The real system's own "Date:" filter also offers a "Period from" mode -- an explicit
// custom range instead of the YTD default -- replicated here via `fromDateOverride`.
// `breakdown` mirrors the real "Generate" split button's 4 modes (Total Only/Months/
// Location/Department): every mode shares this same multi-column pipeline, with
// 'total' simply being the one-column case, so results are always internally
// consistent with each other (e.g. summing the Months columns reproduces the Total).
// Percent-of-revenue per line/column, matching the real payload's `amounts:[[value,pct]]`.
async function buildIncomeStatement(asOfDate, fromDateOverride, breakdown = 'total') {
  const fromDate = fromDateOverride || yearStart(asOfDate);
  const [coaRows, glLines] = await Promise.all([
    loadCoa(),
    getPostedGlLines({ toDate: asOfDate, fromDate }),
  ]);

  let partitions = partitionGlLines(glLines, breakdown, fromDate, asOfDate);
  if (breakdown === 'location' || breakdown === 'department') {
    partitions = await resolvePartitionLabels(partitions, breakdown);
  }
  if (!partitions.length) partitions = [{ key: 'total', label: 'Total', lines: [] }];
  const columns = partitions.map((p) => ({ key: p.key, label: p.label }));

  const balanceMaps = partitions.map((p) => netBalancesByCode(p.lines));
  const roots = buildTreeMulti(coaRows, balanceMaps);

  const revenue = buildIncomeSectionMulti(roots, 'INCOME', INCOME_SECTION_ORDER, -1, columns.length);
  const expense = buildIncomeSectionMulti(roots, 'EXPENSE', EXPENSE_SECTION_ORDER, 1, columns.length);
  const netIncome = revenue.totals.map((v, i) => round2(v - (expense.totals[i] || 0)));

  const withPercent = (sections) => sections.map((s) => ({
    ...s,
    accounts: s.accounts.map((a) => ({
      ...a,
      percents: a.amounts.map((v, i) => (revenue.totals[i] ? round2((v / revenue.totals[i]) * 100) : 0)),
    })),
  }));

  return {
    as_of: asOfDate, from_date: fromDate, breakdown, columns,
    revenue_sections: withPercent(revenue.sections), revenue_totals: revenue.totals,
    expense_sections: withPercent(expense.sections), expense_totals: expense.totals,
    net_income: netIncome,
  };
}

// General Ledger: a flat per-account list (not the parent/child tree TB/BS use), each
// row carrying its own `ledgers` array of the raw GL lines that produced its balance
// (source type/no, date, memo, debit, credit, running balance) -- the real system
// fetches this on-demand via a separate "Expand" click; ours includes it inline since
// this clone's data volumes are small enough that the extra payload is trivial.
async function buildGeneralLedger(asOfDate) {
  const [coaRows, glLines] = await Promise.all([loadCoa(), getPostedGlLines({ toDate: asOfDate })]);

  const linesByCode = new Map();
  for (const l of glLines) {
    if (!linesByCode.has(l.account_code)) linesByCode.set(l.account_code, []);
    linesByCode.get(l.account_code).push(l);
  }

  const rows = [];
  for (const acct of coaRows) {
    if (acct.is_summary) continue;
    const sign = acct.normal_balance === 'CREDIT' ? -1 : 1;
    const own = (linesByCode.get(acct.account_code) || [])
      .slice()
      .sort((a, b) => new Date(a.entry_date) - new Date(b.entry_date) || a.source_id - b.source_id);

    let running = 0;
    const ledgers = own.map((l) => {
      running += ((Number(l.debit) || 0) - (Number(l.credit) || 0)) * sign;
      return {
        entry_date: l.entry_date, source_type: l.source_type, source_no: l.source_no,
        memo: l.memo, debit: round2(l.debit), credit: round2(l.credit), balance: round2(running),
      };
    });

    rows.push({
      account_code: acct.account_code, account_name: acct.account_name,
      normal_balance: acct.normal_balance, balance: round2(running), ledgers,
    });
  }
  return { as_of: asOfDate, rows };
}

module.exports = { buildTrialBalance, buildBalanceSheet, buildIncomeStatement, buildGeneralLedger };
