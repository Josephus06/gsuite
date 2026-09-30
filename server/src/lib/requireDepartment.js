const pool = require('../db');

// Department is REQUIRED on any line that posts to an account a budget covers -- income, expense
// and fixed assets -- so that department budgets have actuals to compare against. Measured
// 2026-09-30: of this year's lines created in T1S, 0 of 566 cheque lines and 0 of 1,248 journal
// lines carried a department, so every department's Budget vs Actual showed almost no spending.
// Lines to balance-sheet accounts (bank, payables, advances) stay optional: a department means
// nothing on them. Only the forms' create routes enforce this; system-made entries (void
// reversals and the like) are never blocked.
const BUDGETED = `(t.account_type IN ('INCOME', 'EXPENSE')
                   OR (t.account_type = 'ASSET' AND t.account_sub_type = 'FIXED ASSETS'))`;

// lines: [{ account_id, department_id }]. Returns an error message naming the first offending
// line, or null when every budgeted line has a department.
async function missingDepartmentError(lines, db = pool) {
  const ids = [...new Set(lines.map((l) => Number(l.account_id)).filter(Boolean))];
  if (!ids.length) return null;
  const [rows] = await db.query(
    `SELECT coa.id, coa.account_code, coa.account_name
       FROM chart_of_accounts coa JOIN chart_of_account_types t ON t.id = coa.coa_type_id
      WHERE coa.id IN (?) AND ${BUDGETED}`, [ids]);
  const budgeted = new Map(rows.map((r) => [Number(r.id), r]));
  for (let i = 0; i < lines.length; i += 1) {
    const a = budgeted.get(Number(lines[i].account_id));
    if (a && !lines[i].department_id) {
      return `Choose a Department on line ${i + 1} (${a.account_code} ${a.account_name}). It is required on income, expense and fixed-asset lines so department budgets can be tracked.`;
    }
  }
  return null;
}

module.exports = { missingDepartmentError };
