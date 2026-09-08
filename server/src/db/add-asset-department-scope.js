// Two changes that belong together, because both answer "whose asset is this?".
//
// 1. OWNING DEPARTMENT. A UPS is IT's; an aircon is Building & Maintenance's. Set on the asset
//    TYPE so it is stated once and every unit inherits it, with a per-asset override for the
//    exception -- the same inherit/override shape as brand and model. The resolved department is
//    what governs who may see and touch the asset: see lib/assetDepartmentScope.js.
//
//    This is a different thing from the custody department the register already had, which came
//    off whichever employee happened to hold the item. That one described where a person sits;
//    this one describes who owns the equipment, and only the second can decide authority.
//
// 2. ASSIGNED LOCATION. A standalone, manually-maintained list of the precise spots an asset can
//    sit in -- "2nd Floor Server Room", "Sales Area", "Rack 3". Deliberately NOT the shared
//    `locations` master and deliberately not derived from departments: locations drive transfers,
//    branches and the rest of the ERP, and overloading them with furniture-level placements would
//    put those entries in front of every other module. Maintained at Lookups > Asset Assigned
//    Locations.
//
// The old assets.department_id column is left in place but is no longer read or written by the
// asset routes -- dropping a column with data in it is not something a migration should do
// quietly, and it costs nothing to leave.
//
//   node src/db/add-asset-department-scope.js --dry-run
//   node src/db/add-asset-department-scope.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const TABLES = [
  ['asset_assigned_locations', `
CREATE TABLE asset_assigned_locations (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    description VARCHAR(500) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uq_asset_assigned_locations_name (name)
)`],
];

const COLUMNS = [
  // The type states the department; every unit under it inherits.
  ['asset_items', 'owning_department_id', 'BIGINT NULL AFTER category'],
  // The per-asset override. NULL means "inherit from the type", which is what keeps the
  // inheritance live rather than freezing a copy at registration time.
  ['assets', 'owning_department_id', 'BIGINT NULL AFTER asset_class_id'],
  ['assets', 'assigned_location_id', 'BIGINT NULL AFTER location_id'],
];

const INDEXES = [
  ['asset_items', 'idx_asset_items_owning_dept', '(owning_department_id)'],
  ['assets', 'idx_assets_owning_dept', '(owning_department_id)'],
  ['assets', 'idx_assets_assigned_location', '(assigned_location_id)'],
];

async function tableExists(name) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return rows.length > 0;
}
async function columnExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}
async function indexExists(table, name) {
  const [rows] = await pool.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name]);
  return rows.length > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  if (!(await tableExists('assets'))) {
    console.error('The assets table does not exist. Run src/db/create-assets-module.js first.');
    process.exit(1);
  }

  for (const [name, ddl] of TABLES) {
    if (await tableExists(name)) console.log(`Table ${name} already exists.`);
    else if (DRY_RUN) console.log(`Would create table ${name}.`);
    else { await pool.query(ddl); console.log(`Created table ${name}.`); }
  }

  console.log('');
  for (const [table, column, definition] of COLUMNS) {
    if (await columnExists(table, column)) console.log(`Column ${table}.${column} already exists.`);
    else if (DRY_RUN) console.log(`Would add column ${table}.${column}.`);
    else { await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`); console.log(`Added column ${table}.${column}.`); }
  }

  for (const [table, name, cols] of INDEXES) {
    if (await indexExists(table, name)) console.log(`Index ${table}.${name} already exists.`);
    else if (DRY_RUN) console.log(`Would add index ${table}.${name}.`);
    else { await pool.query(`ALTER TABLE \`${table}\` ADD INDEX \`${name}\` ${cols}`); console.log(`Added index ${table}.${name}.`); }
  }

  // A type with no department is owned by nobody, which under the scoping rule means only System
  // Admin can see its units. That is the safe default -- it fails closed rather than exposing
  // equipment to the wrong department -- but it is worth saying out loud, because an unassigned
  // type looks like a bug to whoever cannot see their own asset.
  // Guarded on the column actually existing: in a dry run it has not been added yet, and a
  // reporting-only mode that dies querying what it was about to create is worse than useless --
  // it is the run you do specifically to find out whether the real one is safe.
  console.log('');
  if (await tableExists('asset_items') && await columnExists('asset_items', 'owning_department_id')) {
    const [types] = await pool.query('SELECT id, item_code, display_name, owning_department_id FROM asset_items ORDER BY display_name');
    const unassigned = types.filter((t) => !t.owning_department_id);
    console.log(`${types.length} asset type(s); ${unassigned.length} with no owning department yet.`);
    for (const t of unassigned) console.log(`  - ${t.item_code} ${t.display_name}`);
    if (unassigned.length) {
      console.log('\n  Set these at Assets > Asset Types. Until then only a System Admin sees their units.');
    }
  }

  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
