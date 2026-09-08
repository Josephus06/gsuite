// Lets an individual asset carry its own brand, model and specification, overriding the type's.
//
// These three started out only on asset_items (the type), which reads fine for "UPS -> APC 650VA"
// but breaks the moment two units of the same type differ -- a Carrier 2HP and a Panasonic 1.5HP
// are both legitimately an "Aircon". The only ways out were to split the type per brand, which
// fragments the grouped register the module exists to provide, or to leave brand and model blank,
// which is what actually happened. They belong with the serial number, and the serial number is
// per unit.
//
// Category deliberately stays type-level: it describes the kind of thing, not one unit of it.
//
// Nullable and no backfill, because NULL is what makes the override work -- a blank column means
// "inherit from the type", so every asset already registered keeps displaying exactly what it
// displays today. Reads use COALESCE(a.brand, ai.brand); see routes/assets.js.
//
//   node src/db/add-asset-unit-attributes.js --dry-run
//   node src/db/add-asset-unit-attributes.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const COLUMNS = [
  ['assets', 'brand', 'VARCHAR(120) NULL AFTER serial_no'],
  ['assets', 'model', 'VARCHAR(120) NULL AFTER brand'],
  ['assets', 'specification', 'VARCHAR(500) NULL AFTER model'],
];

async function tableExists(name) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return rows.length > 0;
}
async function columnExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  if (!(await tableExists('assets'))) {
    console.error('The assets table does not exist. Run src/db/create-assets-module.js first.');
    process.exit(1);
  }

  for (const [table, column, definition] of COLUMNS) {
    if (await columnExists(table, column)) console.log(`Column ${table}.${column} already exists.`);
    else if (DRY_RUN) console.log(`Would add column ${table}.${column}.`);
    else {
      await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      console.log(`Added column ${table}.${column}.`);
    }
  }

  const [[counts]] = await pool.query('SELECT COUNT(*) AS n FROM assets');
  console.log(`\n${counts.n} asset(s) present -- all keep inheriting from their type until someone overrides.`);

  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
