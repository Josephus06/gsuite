// One-off script: creates login accounts for everyone in the direct reporting chain
// above the 3 parallel-run-test sales reps (Arjie Bayagna, Catherine Jane Langajed,
// Jocel Ann Berina), so the "supervisor sees their people" visibility rule
// (server/src/lib/salesVisibility.js) reflects the REAL reporting chain, not just the
// 3 leaf accounts. Walks each rep's live employee record up via SysFK_Supervisor_Empl,
// collecting every employee in that chain who also has a live User account.
//
// Deliberately NOT importing all 211 live users -- just this chain + whoever's already
// local (admin/arjie/catherine/jocel, left untouched). Real passwords are never exposed
// by the live API (expected -- only a bcrypt-style hash would live server-side there
// too), so every newly-created account gets the same known default password below;
// share it with the actual people and have them change it.
//
// Page permissions are mirrored from each live user's real Permissions_Usr grants,
// mapped onto our local `pages.route` where a page has a clear equivalent (see PAGE_MAP
// below) -- unmapped live pages (Calendar, Sales Report, Commission Scheme, etc. have no
// local equivalent) are simply skipped, which defaults to no access, not silently wrong
// access. Live data has no per-page "approve" flag, so can_approve is always left off.
//
// Not part of the running app -- run manually:
//   node src/db/import-target-users.js
const bcrypt = require('bcryptjs');
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const USERNAME = process.env.LIVE_SITE_USERNAME;
const PASSWORD = process.env.LIVE_SITE_PASSWORD;
const DEFAULT_PASSWORD = 'Welcome123!';

if (!USERNAME || !PASSWORD) {
  console.error('Set LIVE_SITE_USERNAME and LIVE_SITE_PASSWORD in server/.env before running this script.');
  process.exit(1);
}

const TARGET_SALES_REPS = ['Arjie Bayagna', 'Catherine Jane  Langajed', 'Jocel Ann Berina'];

const PAGE_MAP = {
  Employee: '/employees', User: '/users', Customer: '/customers', Supplier: '/suppliers',
  Inventory: '/inventory', Estimate: '/estimates', Process: '/process-costing',
  'Sales Order': '/sales-orders', 'Job Order': '/job-orders', 'PMS - Job Type': '/pms-job-types',
  Production: '/production', 'Stock Ledger Reports': '/stock-ledger-reports',
  'Inventory Adjustment': '/inventory-adjustments', 'Chart of Account Type': '/chart-of-account-types',
  'Chart of Account': '/chart-of-accounts', 'Assembly Build': '/assembly-builds', 'Job Type': '/job-types',
  'Transfer Order': '/transfer-orders', Invoice: '/sales-invoices', 'Purchase Requisition': '/purchase-requisitions',
  'Placing Order Form': '/place-order-form', 'Purchase Order': '/purchase-orders', 'Service Item': '/service-items',
  'Bin Card Reports': '/bin-card-reports', 'Vendor Bill': '/vendor-bills', 'Bill Payment': '/bill-payments',
  'Bill Credit': '/bill-credits',
};

async function login() {
  const res = await fetch(`${SITE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const body = await res.json();
  if (!body?.success || !body?.data?.token) throw new Error(`Login failed: ${body?.message || res.status}`);
  return body.data.token;
}

async function apiCall(token, endpoint, body) {
  const res = await fetch(`${SITE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

function clean(s) { return (s || '').trim().replace(/\s+/g, ' '); }

function slugUsername(liveUsername, name) {
  const raw = clean(liveUsername) || clean(name);
  if (raw.includes('@')) return raw.toLowerCase();
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

async function localEmployeeIdByName(name) {
  const [[row]] = await pool.query(
    'SELECT id FROM employees WHERE LOWER(CONCAT(first_name, " ", last_name)) = LOWER(?)',
    [clean(name)]
  );
  return row ? row.id : null;
}

async function main() {
  const token = await login();
  const employees = (await apiCall(token, 'get_employees', { where: {}, limit: 5000, offset: 0 })).data || [];
  const liveUsers = (await apiCall(token, 'get_users', { where: {}, limit: 5000, offset: 0 })).data || [];

  const empByPk = new Map(employees.map((e) => [e.SysPK_Empl, e]));
  const userByEmplPk = new Map(liveUsers.map((u) => [u.SysFK_Empl_Usr, u]));

  // Walk each target rep's chain upward, collect the ordered chain (rep -> ... -> top)
  // of live users found along the way, de-duplicated across all 3 reps.
  const chainByRep = {};
  const allLiveUsersInChain = new Map(); // Username_Usr -> { liveUser, liveEmployee }
  for (const repName of TARGET_SALES_REPS) {
    const chain = [];
    let cur = employees.find((e) => e.Name_Empl === repName);
    let depth = 0;
    while (cur && depth < 10) {
      const u = userByEmplPk.get(cur.SysPK_Empl);
      if (u) {
        chain.push(u.Username_Usr);
        allLiveUsersInChain.set(u.Username_Usr, { liveUser: u, liveEmployee: cur });
      }
      cur = cur.SysFK_Supervisor_Empl ? empByPk.get(cur.SysFK_Supervisor_Empl) : null;
      depth++;
    }
    chainByRep[repName] = chain;
  }

  console.log(`Chain covers ${allLiveUsersInChain.size} live user accounts across the 3 reps' reporting lines.\n`);

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  const localIdByLiveUsername = new Map();

  for (const [liveUsername, { liveUser, liveEmployee }] of allLiveUsersInChain) {
    const [[existing]] = await pool.query(
      'SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)',
      [liveUsername, liveUser.Email_Usr || '']
    );
    if (existing) {
      console.log(`SKIP ${liveUsername} (already a local account, id=${existing.id})`);
      localIdByLiveUsername.set(liveUsername, existing.id);
      continue;
    }

    const employeeId = await localEmployeeIdByName(liveEmployee.Name_Empl);
    const localUsername = slugUsername(liveUsername, liveEmployee.Name_Empl);

    const [result] = await pool.query(
      `INSERT INTO users
         (employee_id, username, email, password_hash, display_name, is_active, account_type,
          can_approve_sales_estimate, is_account_officer, is_supervisor, is_sales_manager,
          is_sales_marketing_director, is_sales_business_unit, approval_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        employeeId, localUsername, liveUser.Email_Usr || null, passwordHash, clean(liveEmployee.Name_Empl),
        !!liveUser.IsActive_Usr, liveUser.AccountType_Usr || null,
        !!liveUser.IsCanApprovedSales_Usr, !!liveUser.IsAccountOfficer_Usr, !!liveUser.IsSupervisor_Usr,
        !!liveUser.IsSalesManager_Usr, !!liveUser.IsSalesDirector_Usr, !!liveUser.IsSalesBusinessUnit_Usr,
        liveUser.ApprovalCode_Usr || null,
      ]
    );
    localIdByLiveUsername.set(liveUsername, result.insertId);
    console.log(`+ created ${localUsername} (${clean(liveEmployee.Name_Empl)}, ${liveUser.AccountType_Usr})`);

    // Mirror real page permissions where we have a local-route equivalent.
    let perms = [];
    try { perms = JSON.parse(liveUser.Permissions_Usr || '[]'); } catch { /* leave empty */ }
    const [pages] = await pool.query('SELECT id, route FROM pages');
    const pageIdByRoute = new Map(pages.map((p) => [p.route, p.id]));
    // Dashboard/Lookups have no direct live-page equivalent but are safe, low-risk
    // read surfaces every account needs -- grant view by default.
    await pool.query(
      'INSERT INTO user_page_permissions (user_id, page_id, can_view) VALUES (?, ?, TRUE), (?, ?, TRUE)',
      [result.insertId, pageIdByRoute.get('/dashboard'), result.insertId, pageIdByRoute.get('/lookups')]
    );
    let grantedCount = 0;
    for (const p of perms) {
      const route = PAGE_MAP[p.Page];
      if (!route) continue;
      const pageId = pageIdByRoute.get(route);
      if (!pageId) continue;
      if (!p.IsCanView && !p.IsCanAdd && !p.IsCanUpdate && !p.IsCanDelete) continue;
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [result.insertId, pageId, !!p.IsCanView, !!p.IsCanAdd, !!p.IsCanUpdate, !!p.IsCanDelete]
      );
      grantedCount++;
    }
    console.log(`  mirrored ${grantedCount} page permission(s)`);
  }

  // Now link supervisor_id along each chain using the local ids just resolved (or
  // already-existing local accounts) -- one hop per person, matching the real chain.
  let linked = 0;
  for (const repName of TARGET_SALES_REPS) {
    const chain = chainByRep[repName];
    for (let i = 0; i < chain.length - 1; i++) {
      const selfId = localIdByLiveUsername.get(chain[i]);
      const supervisorId = localIdByLiveUsername.get(chain[i + 1]);
      if (!selfId || !supervisorId || selfId === supervisorId) continue;
      await pool.query('UPDATE users SET supervisor_id = ? WHERE id = ? AND supervisor_id IS NULL', [supervisorId, selfId]);
      linked++;
    }
  }
  console.log(`\nLinked supervisor_id for up to ${linked} chain relationship(s) (only where previously NULL).`);
  console.log(`\nDefault password for all newly-created accounts: ${DEFAULT_PASSWORD}`);
  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
