// Adds departments.job_location_id -- the one job location a department's people may see.
//
// A production department only works the warehouse it belongs to: SIGNAGE never touches an
// LFP job, CNC never touches a DPOD one. Before this, every JO list in the ERP showed every
// warehouse's work to anyone with can_view, so a signage user scrolled past four other
// departments' job orders to find their own.
//
// The mapping lives in a column rather than in code so adding a department (or moving one to a
// different warehouse) is a Master Lists edit -- Lookups > Departments > Job Location Restriction
// -- not a deploy. A department with this left empty is unrestricted, which is what every
// non-production department (Sales, Accounting, Design, Support ...) wants.
//
// Seeded with the production departments' current warehouses. Names are matched loosely because
// the live data punctuates them inconsistently -- "Production -  CNC" carries a double space,
// "Warehouse - Sign" is title-cased while its department is "Production-SIGNAGE" -- and the ids
// differ between environments, so nothing here may be keyed on one.
//
// Signage is filed under TWO departments and both are mapped to the same warehouse. Production
// keeps 11 people on "Production - SIGN" and 2 on "Production-SIGNAGE"; sandbox has it the other
// way round. Mapping only one left the larger group seeing every warehouse's job orders.
//
// Only fills where the column is still empty, so a mapping an admin has since changed is kept.
//
// Idempotent -- safe to re-run:
//   node src/db/add-department-job-location.js
const pool = require('../db');
require('dotenv').config();

// "Production -  CNC" and "Production - CNC" are the same department to a human, and the
// separator between a warehouse and its suffix is noise. Compare on letters and digits only.
const normalize = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const SEED = [
  { department: 'Production - LFP', location: 'Warehouse - LFP' },
  { department: 'Production - DPOD', location: 'Warehouse - DPOD' },
  { department: 'Production - CNC', location: 'Warehouse - CNC' },
  { department: 'Production-SIGNAGE', location: 'Warehouse - Sign' },
  { department: 'Production - SIGN', location: 'Warehouse - Sign' },
];

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [cols] = await pool.query(
    `SELECT COLUMN_NAME AS cn FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'departments' AND COLUMN_NAME = 'job_location_id'`,
    [process.env.DB_NAME]
  );
  if (cols.length) {
    console.log('departments.job_location_id already present.');
  } else {
    await pool.query('ALTER TABLE departments ADD COLUMN job_location_id BIGINT NULL');
    await pool.query(
      'ALTER TABLE departments ADD CONSTRAINT departments_job_location_fk FOREIGN KEY (job_location_id) REFERENCES locations (id)'
    );
    console.log('departments.job_location_id added.');
  }

  const [deps] = await pool.query('SELECT id, name FROM departments');
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const depByName = new Map(deps.map((d) => [normalize(d.name), d]));
  const locByName = new Map(locs.map((l) => [normalize(l.location_name), l]));

  for (const { department, location } of SEED) {
    const dep = depByName.get(normalize(department));
    const loc = locByName.get(normalize(location));
    if (!dep) { console.log(`!! No department named "${department}" -- skipped.`); continue; }
    if (!loc) { console.log(`!! No location named "${location}" -- "${department}" left unrestricted.`); continue; }
    const [r] = await pool.query(
      'UPDATE departments SET job_location_id = ? WHERE id = ? AND job_location_id IS NULL',
      [loc.id, dep.id]
    );
    console.log(r.affectedRows
      ? `${dep.name} -> ${loc.location_name}`
      : `${dep.name} already mapped -- left as is.`);
  }

  const [mapped] = await pool.query(
    `SELECT d.name AS department, l.location_name AS location
       FROM departments d JOIN locations l ON l.id = d.job_location_id
      ORDER BY d.name`
  );
  console.log(`\n${mapped.length} restricted department(s):`);
  mapped.forEach((m) => console.log(`  ${m.department} -> ${m.location}`));
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
