// Give each branch department its branch as its Job Location (departments.job_location_id), so the
// branch's production staff see the branch's job orders on Production, Scheduled JO, QI, Assembly
// Build and the rest -- and only those (asked 2026-10-03: SO-72385's JOs, filed at "Branch - SM",
// should show on the SM branch's production). Until now the three branch departments had none,
// which left their production accounts unrestricted: they saw every warehouse's work.
// Sales accounts are not affected -- lib/jobLocationVisibility.js exempts them.
//
// Matched by name, ids differ between installs. Same setting as Lookups > Departments > Job
// Location Restriction. Droplet and office replicate: run on ONE of them.
//
//   node src/db/set-branch-department-locations.js --dry-run
//   node src/db/set-branch-department-locations.js
require('dotenv').config();
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');
// department name -> location name, both normalised
const MAP = [['Branch-SM_Cebu', 'Branch - SM'], ['Branch - Ayala', 'Branch - Ayala'], ['Branch_IT-Park', 'Branch - IT Park']];

(async () => {
  console.log(`${DRY ? 'DRY RUN -- ' : ''}DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [depts] = await pool.query('SELECT id, name, job_location_id FROM departments');
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  for (const [dName, lName] of MAP) {
    const d = depts.filter((x) => norm(x.name) === norm(dName));
    const l = locs.filter((x) => norm(x.location_name) === norm(lName));
    if (d.length !== 1 || l.length !== 1) { console.log(`  ${dName} -> ${lName}: found ${d.length} department(s) / ${l.length} location(s), skipped`); continue; }
    const [[n]] = await pool.query(
      `SELECT COUNT(*) AS n FROM users u JOIN user_branches ub ON ub.user_id = u.id AND ub.is_default = TRUE
        WHERE ub.department_id = ? AND u.is_active = TRUE AND NOT u.is_account_officer AND NOT u.is_supervisor
          AND (u.account_type IS NULL OR u.account_type <> 'System Admin')`, [d[0].id]);
    console.log(`  ${d[0].name} (id ${d[0].id}) -> ${l[0].location_name} (id ${l[0].id}); was ${d[0].job_location_id ?? 'none'}; ${n.n} non-sales user(s) now limited to it`);
    if (!DRY && d[0].job_location_id == null) await pool.query('UPDATE departments SET job_location_id = ? WHERE id = ? AND job_location_id IS NULL', [l[0].id, d[0].id]);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
