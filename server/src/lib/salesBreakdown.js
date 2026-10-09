const pool = require('../db');
const { salesScope, scopeWhere } = require('./salesReportScope');
const { getSbuGroups } = require('./sbuGroups');

// The dashboard's sales breakdown for one month (asked 2026-10-03):
//
//   SBU 1 -- Michelle Riveral            500
//     Sales-1                250            Sales-3                250
//       Arjie (supervisor)   250              Nicole (supervisor)  250
//         Cath               124                Jerome             126
//         Jocel              126                Vanessa            124
//
// Sales are Weighted Sales: the net of tax of every non-cancelled Sales Order line, by the order's
// date -- the same figure as Sales > Weighted Sales per Month and the commission report. A sale
// belongs to the GROUP on its order (sales_orders.sales_division_id), and to the rep on its order.
//
// Inside a group, a supervisor's figure is their TEAM's: their own sales in that group plus those of
// everyone assigned to them (user_supervisors), listed underneath. A rep nobody supervises is listed
// on their own. Groups that belong to no SBU (branches, E-Commerce, Marketing...) come after.
//
// What each viewer gets is lib/salesReportScope.js: an admin everything, an SBU head their group,
// a supervisor their team, an account officer themself.

const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');
const pad2 = (n) => String(n).padStart(2, '0');

function monthBounds(ym) {
  const now = new Date();
  let y = now.getFullYear(); let m = now.getMonth() + 1;
  if (/^\d{4}-\d{2}$/.test(String(ym || ''))) { [y, m] = String(ym).split('-').map(Number); }
  const ny = m === 12 ? y + 1 : y; const nm = m === 12 ? 1 : m + 1;
  return { month: `${y}-${pad2(m)}`, start: `${y}-${pad2(m)}-01`, end: `${ny}-${pad2(nm)}-01` };
}

// Weighted sales for a month inside a viewer's scope, one row per (group, rep). officeLocationId
// narrows to one office, for Sales > Weighted Sales per Month's extract (the dashboard has no
// office filter and passes none).
async function salesRows(userId, start, end, { officeLocationId } = {}) {
  const scope = await salesScope(userId);
  const where = ["(so.status IS NULL OR so.status <> 'cancelled')", 'so.date_created >= ? AND so.date_created < ?'];
  const params = [start, end];
  scopeWhere(scope, where, params);
  if (officeLocationId) { where.push('so.office_location_id = ?'); params.push(Number(officeLocationId)); }
  const [rows] = await pool.query(
    `SELECT so.sales_division_id AS division_id, sd.name AS division_name, so.sales_rep_id AS employee_id,
            CONCAT(e.first_name, ' ', e.last_name) AS rep_name, SUM(COALESCE(sol.net_of_tax, 0)) AS amount
       FROM sales_order_lines sol
       JOIN sales_orders so ON so.id = sol.sales_order_id
       LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
       LEFT JOIN employees e ON e.id = so.sales_rep_id
      WHERE ${where.join(' AND ')}
      GROUP BY so.sales_division_id, sd.name, so.sales_rep_id, rep_name`, params);
  return { scope, rows: rows.map((r) => ({ ...r, amount: Number(r.amount) })) };
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// One group's supervisors (with their teams) and unsupervised reps.
function buildGroup(divisionId, name, reps, people) {
  const byEmp = new Map(reps.map((r) => [Number(r.employee_id), r]));
  const supervisors = new Map(); // supervisor user id -> entry
  const covered = new Set();
  const entryFor = (supUserId) => {
    if (!supervisors.has(supUserId)) {
      const u = people.userById.get(supUserId);
      supervisors.set(supUserId, { userId: supUserId, employeeId: u?.employee_id ?? null, name: u?.name || 'Supervisor', own: 0, members: [] });
    }
    return supervisors.get(supUserId);
  };
  for (const r of reps) {
    const u = people.userByEmp.get(Number(r.employee_id));
    const sups = u ? (people.supsOf.get(u.id) || []) : [];
    // An SBU head's own sales stand on their own line, not under whoever they report to.
    if (u && u.is_sales_business_unit) continue;
    // A supervisor gets their own entry (with their team) rather than a line under their own boss.
    for (const s of (u && u.is_supervisor ? [] : sups)) {
      entryFor(s).members.push({ name: r.rep_name || '(no sales rep)', amount: round2(r.amount) });
      covered.add(Number(r.employee_id));
    }
    if (u && u.is_supervisor) { entryFor(u.id).own = round2(r.amount); covered.add(Number(r.employee_id)); }
  }
  const sups = [...supervisors.values()]
    .map((s) => ({ ...s, members: s.members.sort((a, b) => b.amount - a.amount),
      team: round2(s.own + s.members.reduce((t, m) => t + m.amount, 0)) }))
    .filter((s) => s.team > 0)
    .sort((a, b) => b.team - a.team);
  const others = reps.filter((r) => !covered.has(Number(r.employee_id)))
    .map((r) => ({ name: r.rep_name || '(no sales rep)', amount: round2(r.amount) }))
    .sort((a, b) => b.amount - a.amount);
  return {
    id: divisionId, name: name || '(no group)', total: round2([...byEmp.values()].reduce((t, r) => t + r.amount, 0)),
    supervisors: sups, others,
  };
}

async function buildSalesBreakdown(userId, ym, filters = {}) {
  const { month, start, end } = monthBounds(ym);
  const { scope, rows } = await salesRows(userId, start, end, filters);

  // Everyone's user account and supervisors, once.
  const [users] = await pool.query(
    `SELECT u.id, u.employee_id, u.is_supervisor, u.is_sales_business_unit, COALESCE(CONCAT(e.first_name, ' ', e.last_name), u.display_name) AS name
       FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.is_active = TRUE`);
  const [links] = await pool.query('SELECT user_id, supervisor_id FROM user_supervisors');
  const people = {
    userById: new Map(users.map((u) => [u.id, u])),
    userByEmp: new Map(users.filter((u) => u.employee_id).map((u) => [Number(u.employee_id), u])),
    supsOf: new Map(),
  };
  for (const l of links) {
    if (!people.userById.has(l.supervisor_id) || l.supervisor_id === l.user_id) continue;
    if (!people.supsOf.has(l.user_id)) people.supsOf.set(l.user_id, []);
    people.supsOf.get(l.user_id).push(l.supervisor_id);
  }

  const byDivision = new Map();
  for (const r of rows) {
    const k = r.division_id ?? 0;
    if (!byDivision.has(k)) byDivision.set(k, { name: r.division_name, reps: [] });
    byDivision.get(k).reps.push(r);
  }
  const groups = new Map([...byDivision.entries()].map(([id, d]) => [id, buildGroup(id, d.name, d.reps, people)]));

  // A supervisor or account officer sees only their own people: no SBU heading, no SBU total --
  // just the group(s) their team sold in. The SBU level is for SBU heads and admins.
  if (scope.kind === 'supervisor' || scope.kind === 'own' || scope.kind === 'none') {
    return {
      month, scope: scope.kind, total: round2(rows.reduce((t, r) => t + r.amount, 0)),
      sbus: [], otherGroups: [...groups.values()].sort((a, b) => b.total - a.total), flat: true,
    };
  }

  // SBUs own groups by name (their ownership is recorded against departments; see lib/sbuGroups.js).
  const sbuDefs = await getSbuGroups();
  const used = new Set();
  const sbus = sbuDefs.map((s) => {
    const keys = new Set(s.departmentNames.map(norm));
    const mine = [...groups.values()].filter((g) => keys.has(norm(g.name)));
    mine.forEach((g) => used.add(g.id));
    return { label: s.label, owner: s.displayName, total: round2(mine.reduce((t, g) => t + g.total, 0)),
      groups: mine.sort((a, b) => norm(a.name).localeCompare(norm(b.name))) };
  }).filter((s) => s.groups.length);
  const otherGroups = [...groups.values()].filter((g) => !used.has(g.id)).sort((a, b) => b.total - a.total);

  return {
    month, scope: scope.kind,
    total: round2(rows.reduce((t, r) => t + r.amount, 0)),
    sbus, otherGroups,
  };
}

// The viewer's Weighted Sales for a month and how many orders it came from -- the dashboard's
// "Sales This Month" card. Same scope and figure as the breakdown, so the card and the
// breakdown's total always agree (an SBU head's card is their SBU's, not the company's).
async function scopedMonthSales(userId, ym) {
  const { start, end } = monthBounds(ym);
  const scope = await salesScope(userId);
  const where = ["(so.status IS NULL OR so.status <> 'cancelled')", 'so.date_created >= ? AND so.date_created < ?'];
  const params = [start, end];
  scopeWhere(scope, where, params);
  const [[r]] = await pool.query(
    `SELECT COUNT(DISTINCT so.id) AS count, COALESCE(SUM(sol.net_of_tax), 0) AS amount
       FROM sales_order_lines sol JOIN sales_orders so ON so.id = sol.sales_order_id
      WHERE ${where.join(' AND ')}`, params);
  return { count: Number(r.count), amount: round2(r.amount) };
}

module.exports = { buildSalesBreakdown, scopedMonthSales, monthBounds };
