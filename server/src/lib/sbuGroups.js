const pool = require('../db');

// The two SBU groups, resolved from data rather than hardcoded ids, so adding a third SBU
// or moving a division between them is a configuration change and not a code change.
//
// THE ID TRAP THIS EXISTS TO ABSORB. Ownership lives in user_sales_divisions, which points
// at `sales_divisions`; the documents point at `departments`
// (non_standard_job_orders.sales_division_id is a DEPARTMENT id, despite the column name,
// and a ticket's group comes from its creator's employees.department_id). The two tables
// number the same team differently -- id 5 is department "Sales - 1" but sales_division
// "Sales - 2" -- so the join can only be made on the name, and the names disagree on
// spacing ("Sales-1" vs "Sales - 1"). Everything is matched on a normalised key instead;
// the chatbot already treats division names this way for the same reason.
const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');

// Groups are numbered by the lowest department id they own, which is what makes Michelle's
// group (Sales - 1, Sales - 3) "SBU 1" and Arlene's (Sales - 2, Sales - 4) "SBU 2" --
// the numbering users already use for them.
async function getSbuGroups() {
  // A System Admin account carrying the SBU flag is not a real SBU group -- on the live
  // database the admin account has it set and owns EVERY division, which would both take
  // the "SBU 1" label off the actual first SBU and, because a group's scope is the union of
  // all groups, silently widen every SBU's view to every division in the company. An admin
  // already sees everything through their own scope, so excluding them costs nothing.
  const [owners] = await pool.query(
    `SELECT u.id AS user_id, u.display_name, sd.name AS division_name
       FROM users u
       JOIN user_sales_divisions usd ON usd.user_id = u.id
       JOIN sales_divisions sd ON sd.id = usd.sales_division_id
      WHERE u.is_sales_business_unit = TRUE AND u.is_active = TRUE
        AND (u.account_type IS NULL OR u.account_type <> 'System Admin')`
  );
  if (!owners.length) return [];

  const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE');
  const departmentByKey = new Map(departments.map((d) => [norm(d.name), d]));

  const byUser = new Map();
  for (const row of owners) {
    const department = departmentByKey.get(norm(row.division_name));
    if (!department) continue; // a division with no matching department owns no documents
    if (!byUser.has(row.user_id)) {
      byUser.set(row.user_id, { userId: row.user_id, displayName: row.display_name, departmentIds: [], departmentNames: [] });
    }
    const group = byUser.get(row.user_id);
    group.departmentIds.push(department.id);
    group.departmentNames.push(department.name);
  }

  return [...byUser.values()]
    .filter((g) => g.departmentIds.length)
    .sort((a, b) => Math.min(...a.departmentIds) - Math.min(...b.departmentIds))
    .map((g, i) => ({ ...g, index: i + 1, label: `SBU ${i + 1}` }));
}

// An SBU sees BOTH groups' non-standard job orders and tickets -- that is the whole point
// of the cross-approval arrangement, and an approver who cannot find a document cannot
// approve it. Returns null for everyone else, leaving their existing scope untouched.
async function getSbuScope(userId) {
  const [[user]] = await pool.query(
    'SELECT is_sales_business_unit FROM users WHERE id = ? AND is_active = TRUE',
    [userId]
  );
  if (!user?.is_sales_business_unit) return null;

  const groups = await getSbuGroups();
  if (!groups.length) return null;
  return { groups, departmentIds: groups.flatMap((g) => g.departmentIds) };
}

// Narrows a scope to one tab. An unknown/absent index means "both", so a stale bookmark
// widens to everything this user may see rather than silently showing an empty list.
function departmentIdsForTab(scope, sbuIndex) {
  const wanted = Number(sbuIndex);
  const group = scope.groups.find((g) => g.index === wanted);
  return group ? group.departmentIds : scope.departmentIds;
}

module.exports = { getSbuGroups, getSbuScope, departmentIdsForTab };
