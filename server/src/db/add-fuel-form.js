// Forms > Fuel Request (asked 2026-10-19) and the per-user monthly fuel limit.
//
//   form_fuel_details     one row per Fuel Request: date, vehicle (a Fleet vehicle, or typed), litres,
//                         price / amount, odometer, station, purpose -- and, once approved for a Fleet
//                         vehicle, the fuel log entry it made (vehicle_fuel_logs)
//   users.has_fuel_limit  ticked in Users & Permissions: the user has a monthly limit
//   users.fuel_limit_liters  how many litres a month; a request that would take the month past it is
//                         refused at submit (routes/forms.js)
//   users.is_fuel_approver   tagged: approves Fuel Requests, which are not noted
//
// form_requests.type is a VARCHAR -- the new type needs no change there. Idempotent.
// Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-fuel-form.js --dry-run
//   node src/db/add-fuel-form.js
require('dotenv').config();
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');

async function columnExists(table, col) {
  const [[r]] = await pool.query(
    'SELECT 1 AS ok FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, col]);
  return !!r;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY ? ' -- DRY RUN' : ''}\n`);
  const [[t]] = await pool.query(
    "SELECT 1 AS ok FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_fuel_details'");
  if (t) console.log('= form_fuel_details already exists');
  else if (DRY) console.log('~ would create form_fuel_details');
  else {
    const [[col]] = await pool.query(
      "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_requests' AND COLUMN_NAME = 'id'");
    await pool.query(`CREATE TABLE form_fuel_details (
        form_request_id ${col.t} NOT NULL PRIMARY KEY,
        fuel_date DATE NOT NULL,
        vehicle_asset_id BIGINT NULL,
        vehicle_label VARCHAR(120) NULL,
        liters DECIMAL(10,3) NOT NULL,
        price_per_liter DECIMAL(10,2) NULL,
        amount DECIMAL(14,2) NULL,
        odometer_km DECIMAL(12,1) NULL,
        station VARCHAR(120) NULL,
        purpose TEXT NULL,
        fuel_log_id BIGINT NULL,
        KEY idx_ffd_date (fuel_date),
        CONSTRAINT fk_ffd_form FOREIGN KEY (form_request_id) REFERENCES form_requests(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('+ created form_fuel_details');
  }
  for (const [col, ddl] of [
    ['has_fuel_limit', 'ADD COLUMN has_fuel_limit TINYINT(1) NOT NULL DEFAULT 0'],
    ['fuel_limit_liters', 'ADD COLUMN fuel_limit_liters DECIMAL(10,2) NULL'],
    ['is_fuel_approver', 'ADD COLUMN is_fuel_approver TINYINT(1) NOT NULL DEFAULT 0'],
  ]) {
    if (await columnExists('users', col)) { console.log(`= users.${col} already exists`); continue; }
    if (DRY) { console.log(`~ would add users.${col}`); continue; }
    await pool.query(`ALTER TABLE users ${ddl}`);
    console.log(`+ added users.${col}`);
  }
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
