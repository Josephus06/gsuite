// One-off script: imports the full real Employee directory (270 records) from the live
// GraphicStar site, so that any future estimate/transaction import for ANY sales rep (not
// just the 3 targeted for the current parallel-run test) matches against a real, complete
// employee record instead of auto-creating an incomplete "LIVE-<timestamp>" stub with just
// a first/last name split from a transaction's employee field.
//
// Plain server-side fetch, no browser needed (see server/src/lib/liveEstimateSync.js for
// how the live site's login/API auth was reverse-engineered).
//
// Idempotent: matches existing local employees by name (case-insensitive) and updates
// them in place; creates new rows for anyone not already present. Safe to re-run.
//
// Not part of the running app -- run manually:
//   node src/db/import-all-employees.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const USERNAME = process.env.LIVE_SITE_USERNAME;
const PASSWORD = process.env.LIVE_SITE_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('Set LIVE_SITE_USERNAME and LIVE_SITE_PASSWORD in server/.env before running this script.');
  process.exit(1);
}

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

async function main() {
  const token = await login();
  const resp = await apiCall(token, 'get_employees', { where: {}, limit: 5000, offset: 0 });
  const liveEmployees = resp?.data || [];
  console.log(`Fetched ${liveEmployees.length} employees from live site.\n`);

  const [localRows] = await pool.query('SELECT id, employee_code, first_name, last_name FROM employees');
  const localByName = new Map(localRows.map((r) => [`${r.first_name} ${r.last_name}`.toLowerCase().trim(), r]));

  let created = 0, updated = 0, skipped = 0;
  for (const e of liveEmployees) {
    const name = clean(e.Name_Empl);
    if (!name) { skipped++; continue; }
    const parts = name.split(' ').filter(Boolean);
    const firstName = parts[0] || name;
    const lastName = parts.slice(1).join(' ') || '-';
    const existing = localByName.get(name.toLowerCase());
    // ID_Empl is NOT guaranteed unique on the live site (confirmed: two different real
    // employees share ID_Empl 28) -- suffix with part of the real SysPK to guarantee a
    // unique local code instead of trusting it.
    const code = `EMP-${e.ID_Empl}-${e.SysPK_Empl.slice(0, 8)}`;

    if (existing) {
      await pool.query(
        `UPDATE employees SET employee_code = ?, first_name = ?, last_name = ?, position_title = ?, phone = ?, is_active = ?
         WHERE id = ?`,
        [
          // Only replace a stub "LIVE-<timestamp>" code with the real one; leave a
          // deliberately-assigned local code (e.g. seed data) untouched.
          existing.employee_code?.startsWith('LIVE-') ? code : existing.employee_code,
          firstName, lastName, e.Position_Empl || null, e.ContactNo_Empl || null, !!e.IsActive_Empl,
          existing.id,
        ]
      );
      updated++;
    } else {
      await pool.query(
        `INSERT INTO employees (employee_code, first_name, last_name, position_title, phone, is_active)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [code, firstName, lastName, e.Position_Empl || null, e.ContactNo_Empl || null, !!e.IsActive_Empl]
      );
      created++;
    }
  }

  console.log(`Done. Created ${created}, updated ${updated}, skipped ${skipped} (no name).`);
  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
