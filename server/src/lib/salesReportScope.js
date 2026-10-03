const pool = require('../db');
const { getTeamEmployeeIds, getSbuDivisionIds } = require('./commissionReport');

// Whose Sales Orders a sales report shows this user -- shared by Sales > Weighted Sales per Month
// and the dashboard's sales breakdown, so the two can never disagree about who sees what.
// Most senior role first:
//   SBU Head        -- every order in the sales divisions they own, plus their reporting tree
//   Supervisor      -- their own orders and everyone under them (the whole tree, not one level)
//   Account Officer -- their own orders only
//   anyone else     -- everything (System Admin, accounting, management)
// The same rollup the commission report uses.
async function salesScope(userId) {
  const [[u]] = await pool.query(
    `SELECT id, account_type, employee_id, is_sales_business_unit, is_supervisor, is_account_officer
       FROM users WHERE id = ?`, [userId]);
  if (!u || u.account_type === 'System Admin') return { kind: 'all' };
  if (u.is_sales_business_unit) {
    const divisions = await getSbuDivisionIds(u.id);
    const team = u.employee_id ? await getTeamEmployeeIds(u.employee_id, u.id) : [];
    if (divisions.length || team.length) return { kind: 'sbu', divisions, team };
  }
  if (!u.employee_id && (u.is_supervisor || u.is_account_officer)) return { kind: 'none' };
  if (u.is_supervisor) return { kind: 'supervisor', team: await getTeamEmployeeIds(u.employee_id, u.id) };
  if (u.is_account_officer) return { kind: 'own', team: [u.employee_id] };
  return { kind: 'all' };
}

function scopeWhere(scope, where, params) {
  if (scope.kind === 'none') { where.push('1 = 0'); return; }
  if (scope.kind === 'all') return;
  if (scope.kind === 'sbu') {
    const parts = [];
    if (scope.divisions.length) { parts.push('so.sales_division_id IN (?)'); params.push(scope.divisions); }
    if (scope.team.length) { parts.push('so.sales_rep_id IN (?)'); params.push(scope.team); }
    where.push(`(${parts.join(' OR ')})`);
    return;
  }
  where.push('so.sales_rep_id IN (?)'); params.push(scope.team);
}

module.exports = { salesScope, scopeWhere };
