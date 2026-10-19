// Assets > Fleet (asked 2026-10-19): vehicles are assets (class Transportation Equipment); this adds
// what a vehicle needs on top -- its registration, insurance and emission dates, PMS interval and
// odometer, a PMS / maintenance log and a fuel log -- and the Fleet page's permission.
//
//   vehicle_details        one row per vehicle asset: plate, engine / chassis no., make / model /
//                          year, OR/CR, registration / insurance / emission expiry, odometer, the
//                          PMS interval (km and/or months, set per vehicle), assigned driver and the
//                          vehicle in-charge (Technical Department)
//   vehicle_service_logs   PMS, repairs, tires ... -- date, odometer, work done, shop, cost (recorded
//                          only, not posted), and when the next PMS falls due
//   vehicle_fuel_logs      fill-ups: date, odometer, litres, price, amount, station, driver -- km per
//                          litre is worked out between consecutive fill-ups
//   vehicle_reminders_sent which reminder (kind + due date) went out, so a daily run never repeats one
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/create-fleet-module.js --dry-run
//   node src/db/create-fleet-module.js
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const ROUTE = '/assets/fleet';
const NAME = 'Fleet (Vehicles)';
const MODULE = 'Assets';

const TABLES = {
  vehicle_details: `CREATE TABLE vehicle_details (
      asset_id BIGINT PRIMARY KEY,
      plate_no VARCHAR(30) NULL,
      conduction_sticker VARCHAR(30) NULL,
      engine_no VARCHAR(60) NULL,
      chassis_no VARCHAR(60) NULL,
      make VARCHAR(60) NULL,
      model VARCHAR(80) NULL,
      year_model SMALLINT NULL,
      color VARCHAR(40) NULL,
      fuel_type VARCHAR(20) NULL,
      or_no VARCHAR(40) NULL,
      cr_no VARCHAR(40) NULL,
      registration_date DATE NULL,
      registration_expiry DATE NULL,
      insurer VARCHAR(120) NULL,
      policy_no VARCHAR(60) NULL,
      insurance_expiry DATE NULL,
      emission_expiry DATE NULL,
      odometer_km DECIMAL(12,1) NULL,
      odometer_at DATE NULL,
      pms_interval_km DECIMAL(10,1) NULL,
      pms_interval_months SMALLINT NULL,
      driver_employee_id BIGINT NULL,
      incharge_employee_id BIGINT NULL,
      remarks TEXT NULL,
      updated_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_vd_plate (plate_no)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  vehicle_service_logs: `CREATE TABLE vehicle_service_logs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      asset_id BIGINT NOT NULL,
      service_date DATE NOT NULL,
      odometer_km DECIMAL(12,1) NULL,
      service_type VARCHAR(40) NOT NULL,
      is_pms TINYINT(1) NOT NULL DEFAULT 0,
      work_done TEXT NULL,
      shop VARCHAR(120) NULL,
      cost DECIMAL(14,2) NULL,
      reference_no VARCHAR(60) NULL,
      next_due_date DATE NULL,
      next_due_km DECIMAL(12,1) NULL,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_vsl_asset (asset_id, service_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  vehicle_fuel_logs: `CREATE TABLE vehicle_fuel_logs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      asset_id BIGINT NOT NULL,
      fuel_date DATE NOT NULL,
      odometer_km DECIMAL(12,1) NULL,
      liters DECIMAL(10,3) NOT NULL,
      price_per_liter DECIMAL(10,2) NULL,
      amount DECIMAL(14,2) NULL,
      is_full_tank TINYINT(1) NOT NULL DEFAULT 1,
      station VARCHAR(120) NULL,
      driver_employee_id BIGINT NULL,
      receipt_no VARCHAR(60) NULL,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_vfl_asset (asset_id, fuel_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  vehicle_reminders_sent: `CREATE TABLE vehicle_reminders_sent (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      asset_id BIGINT NOT NULL,
      kind VARCHAR(30) NOT NULL,
      due_key VARCHAR(40) NOT NULL,
      sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_vrs (asset_id, kind, due_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
};

async function createTables() {
  for (const [name, ddl] of Object.entries(TABLES)) {
    const [exists] = await pool.query('SHOW TABLES LIKE ?', [name]);
    if (exists.length) { console.log(`= ${name} already exists`); continue; }
    if (DRY_RUN) { console.log(`~ would create ${name}`); continue; }
    await pool.query(ddl);
    console.log(`+ created ${name}`);
  }
}

async function registerPage() {
  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (existing) { console.log(`= page ${ROUTE} already registered (id ${existing.id})`); return existing.id; }
  if (DRY_RUN) { console.log(`~ would register ${ROUTE} as "${NAME}"`); return null; }
  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  const has = new Set(cols.map((c) => c.Field));
  const fields = ['route', 'name'];
  const values = [ROUTE, NAME];
  if (has.has('module')) { fields.push('module'); values.push(MODULE); }
  const [result] = await pool.query(
    `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values);
  console.log(`+ registered ${ROUTE} as "${NAME}" (id ${result.insertId})`);
  return result.insertId;
}

async function grantAdmins(pageId) {
  if (!pageId) return;
  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const user of admins) {
    const [[existing]] = await pool.query(
      'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, pageId]);
    if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get view/add/edit/delete`); continue; }
    if (existing) {
      await pool.query('UPDATE user_page_permissions SET can_view = TRUE, can_add = TRUE, can_edit = TRUE, can_delete = TRUE WHERE id = ?', [existing.id]);
    } else {
      await pool.query(
        'INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete) VALUES (?, ?, TRUE, TRUE, TRUE, TRUE)',
        [user.id, pageId]);
    }
    console.log(`  + ${user.display_name}: view/add/edit/delete`);
  }
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- nothing will be written.\n' : 'APPLYING changes.\n');
  await createTables();
  await grantAdmins(await registerPage());
  await pool.end();
}

main().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
