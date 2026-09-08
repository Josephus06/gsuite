// One-off migration: creates the Assets Monitoring module -- an item/asset register that always
// answers "where is reference 1542, and who is holding it?", plus the transfer document that is
// the only sanctioned way for that answer to change.
//
// Two levels, because that is how the equipment is actually described:
//
//   UPS            <- asset_items: the type ("UPS", "RAM 8 GB", "System Unit", "Monitor")
//     Ref 023123   <- assets: the individual unit, identified by its reference number
//     Ref 123124
//
// A unit may also hang off another unit (parent_asset_id): the UPS with reference 1542 is
// attached to the System Unit called "PC 1". Attached units have no location of their own --
// they are wherever their root holder is -- so plugging a UPS into a PC that later moves does
// not leave the UPS recorded at the old site. See lib/assetCustody.js.
//
// Custody changes go through asset_transfers, which needs BOTH sides to sign: the releasing
// custodian gives it up, then the receiving custodian accepts it, and only then may IT complete
// the move. Every completed move writes an asset_movements row, so the month-end audit reads a
// ledger rather than a mutable current-state column.
//
//   node src/db/create-assets-module.js --dry-run
//   node src/db/create-assets-module.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const PAGES = [
  { route: '/asset-items', name: 'Asset Types', module: 'Assets' },
  { route: '/assets', name: 'Assets', module: 'Assets' },
  { route: '/asset-transfers', name: 'Asset Transfers', module: 'Assets' },
  { route: '/asset-audits', name: 'Asset Audits', module: 'Assets' },
];

const TABLES = [
  // The type, not the thing you can point at: "UPS", "RAM 8 GB". Reference numbers live in
  // `assets` below. Category is a plain VARCHAR rather than another lookup table -- the
  // grouping wanted here ("IT Equipment", "Furniture") is a label, and a second table would
  // have to be maintained before anyone could register their first asset.
  ['asset_items', `
CREATE TABLE asset_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    item_code VARCHAR(40) UNIQUE NOT NULL,
    display_name VARCHAR(200) NOT NULL,
    category VARCHAR(100) NULL,
    brand VARCHAR(120) NULL,
    model VARCHAR(120) NULL,
    specification VARCHAR(500) NULL,
    description VARCHAR(1000) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    INDEX idx_asset_items_name (display_name),
    INDEX idx_asset_items_category (category)
)`],

  // One physical unit. reference_no is the number the audit team calls out, so it is UNIQUE and
  // required -- an asset nobody can name is not monitorable.
  //
  // location_id / custodian_employee_id are the RECORDED holder and are only meaningful on a
  // root asset; an attached unit (parent_asset_id set) inherits them, and the API refuses to
  // set them directly. Reading them straight out of this table is therefore wrong for attached
  // units -- go through lib/assetCustody.js resolveCustody().
  ['assets', `
CREATE TABLE assets (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    reference_no VARCHAR(60) UNIQUE NOT NULL,
    asset_item_id BIGINT NOT NULL,
    parent_asset_id BIGINT NULL,
    serial_no VARCHAR(120) NULL,
    tag_no VARCHAR(60) NULL,
    location_id BIGINT NULL,
    custodian_employee_id BIGINT NULL,
    department_id BIGINT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    asset_condition VARCHAR(30) NOT NULL DEFAULT 'good',
    acquired_date DATE NULL,
    acquisition_cost DECIMAL(16,2) NULL,
    remarks VARCHAR(1000) NULL,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    INDEX idx_assets_item (asset_item_id),
    INDEX idx_assets_parent (parent_asset_id),
    INDEX idx_assets_location (location_id),
    INDEX idx_assets_custodian (custodian_employee_id),
    INDEX idx_assets_status (status)
)`],

  // The transfer document. Both custodian columns are snapshots taken when the request is
  // raised: they say who agreed to what, and must not follow the asset if it moves again.
  ['asset_transfers', `
CREATE TABLE asset_transfers (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    transfer_no VARCHAR(40) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    date_needed DATE NULL,
    from_location_id BIGINT NULL,
    from_custodian_employee_id BIGINT NULL,
    to_location_id BIGINT NOT NULL,
    to_custodian_employee_id BIGINT NULL,
    to_department_id BIGINT NULL,
    reason VARCHAR(500) NULL,
    memo VARCHAR(1000) NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    requested_by_user_id BIGINT NULL,
    released_by_user_id BIGINT NULL,
    released_at DATETIME NULL,
    release_remarks VARCHAR(500) NULL,
    received_by_user_id BIGINT NULL,
    received_at DATETIME NULL,
    receipt_remarks VARCHAR(500) NULL,
    completed_by_user_id BIGINT NULL,
    completed_at DATETIME NULL,
    rejected_by_user_id BIGINT NULL,
    rejected_at DATETIME NULL,
    reject_reason VARCHAR(500) NULL,
    cancelled_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    INDEX idx_asset_transfers_status (status),
    INDEX idx_asset_transfers_date (date_created),
    INDEX idx_asset_transfers_to_loc (to_location_id)
)`],

  ['asset_transfer_lines', `
CREATE TABLE asset_transfer_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    transfer_id BIGINT NOT NULL,
    line_no INT NOT NULL,
    asset_id BIGINT NOT NULL,
    from_location_id BIGINT NULL,
    from_custodian_employee_id BIGINT NULL,
    remarks VARCHAR(500) NULL,
    INDEX idx_atl_parent (transfer_id),
    INDEX idx_atl_asset (asset_id)
)`],

  // The custody ledger: append-only, one row per change of hands. This is what the audit team
  // reads to see how an asset got where it is -- assets.location_id alone can only ever show
  // the latest state, which is exactly what an audit is not allowed to take on trust.
  ['asset_movements', `
CREATE TABLE asset_movements (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    asset_id BIGINT NOT NULL,
    movement_type VARCHAR(30) NOT NULL,
    transfer_id BIGINT NULL,
    audit_id BIGINT NULL,
    from_location_id BIGINT NULL,
    from_custodian_employee_id BIGINT NULL,
    to_location_id BIGINT NULL,
    to_custodian_employee_id BIGINT NULL,
    remarks VARCHAR(500) NULL,
    moved_by_user_id BIGINT NULL,
    moved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_asset_movements_asset (asset_id, moved_at),
    INDEX idx_asset_movements_transfer (transfer_id)
)`],

  // The month-end count sheet. A snapshot: expected_* is frozen when the sheet is generated, so
  // a transfer completed mid-count cannot quietly rewrite what the auditor was asked to verify.
  ['asset_audits', `
CREATE TABLE asset_audits (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    audit_no VARCHAR(40) UNIQUE NOT NULL,
    period_month DATE NOT NULL,
    location_id BIGINT NULL,
    custodian_employee_id BIGINT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'open',
    memo VARCHAR(1000) NULL,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_by_user_id BIGINT NULL,
    completed_at DATETIME NULL,
    cancelled_at DATETIME NULL,
    INDEX idx_asset_audits_period (period_month),
    INDEX idx_asset_audits_status (status)
)`],

  ['asset_audit_lines', `
CREATE TABLE asset_audit_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    audit_id BIGINT NOT NULL,
    line_no INT NOT NULL,
    asset_id BIGINT NOT NULL,
    expected_location_id BIGINT NULL,
    expected_custodian_employee_id BIGINT NULL,
    result VARCHAR(30) NOT NULL DEFAULT 'pending',
    found_location_id BIGINT NULL,
    found_custodian_employee_id BIGINT NULL,
    remarks VARCHAR(500) NULL,
    verified_by_user_id BIGINT NULL,
    verified_at DATETIME NULL,
    INDEX idx_aal_parent (audit_id),
    INDEX idx_aal_asset (asset_id),
    UNIQUE KEY uq_aal_audit_asset (audit_id, asset_id)
)`],
];

async function tableExists(name) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return rows.length > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  for (const [name, ddl] of TABLES) {
    if (await tableExists(name)) console.log(`Table ${name} already exists.`);
    else if (DRY_RUN) console.log(`Would create table ${name}.`);
    else { await pool.query(ddl); console.log(`Created table ${name}.`); }
  }

  const [admins] = await pool.query("SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const p of PAGES) {
    let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [p.route]);
    if (page) console.log(`\nPage ${p.route} already registered (id ${page.id}).`);
    else if (DRY_RUN) console.log(`\nWould register ${p.route} as "${p.name}".`);
    else {
      const [cols] = await pool.query('SHOW COLUMNS FROM pages');
      const has = new Set(cols.map((c) => c.Field));
      const fields = ['route', 'name'];
      const values = [p.route, p.name];
      if (has.has('module')) { fields.push('module'); values.push(p.module); }
      const [result] = await pool.query(
        `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
        values,
      );
      page = { id: result.insertId };
      console.log(`\nRegistered ${p.route} as "${p.name}" (id ${page.id}).`);
    }
    if (!page) continue;
    for (const user of admins) {
      const [[existing]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id]);
      if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get full access.`); continue; }
      if (existing) {
        await pool.query('UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE WHERE id = ?', [existing.id]);
      } else {
        await pool.query(
          'INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve) VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)',
          [user.id, page.id],
        );
      }
      console.log(`  + ${user.display_name}: full access.`);
    }
  }
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
