// STP -- Sales Territory Planning (routes/stp.js, client/src/pages/stp/). Creates the module's
// tables, seeds the RFVC scoring defaults, registers the /stp permission page and gives System
// Admins full access. Grant others from Users & Permissions afterwards:
//   STP View  = can_view            -- see territories, accounts, reps, scores
//   STP Edit  = can_add + can_edit  -- add / change territories, accounts and visits; recalculate scores
//   STP Admin = can_delete          -- scoring settings, tier overrides, rep capacity, deleting territories / accounts
//
// Tables (no company column: this ERP serves one company):
//   stp_territories      a named territory per fiscal year, its rep, coverage and ₱ target
//   stp_accounts         a customer, lead or named prospect assigned to a territory. fiscal_year is
//                        copied from the territory so "one customer in one territory per year" is a
//                        unique key, not a hope
//   stp_visits           the visit log; saving one moves stp_accounts.last_visit_date forward
//   stp_rep_capacity     how many accounts a rep can carry, per fiscal year
//   stp_scoring_settings the single row of RFVC cut-offs, weights and tier cut-offs (id = 1)
//   stp_account_scores   every scoring run's results -- history, never overwritten
//
// Idempotent. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/create-stp-module.js --dry-run
//   node src/db/create-stp-module.js
require('dotenv').config();
const pool = require('../db');
const { DEFAULT_SETTINGS, settingsToRow } = require('../lib/stpScoring');

const DRY_RUN = process.argv.includes('--dry-run');
const ROUTE = '/stp';
const NAME = 'STP (Sales Territory Planning)';
const MODULE = 'STP';

const TABLES = {
  stp_territories: `CREATE TABLE stp_territories (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      fiscal_year SMALLINT UNSIGNED NOT NULL,
      name VARCHAR(150) NOT NULL,
      rep_user_id BIGINT NULL,
      coverage_area TEXT NULL,
      target_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'Planned',
      notes TEXT NULL,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by_user_id BIGINT NULL,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_stp_territory_name (fiscal_year, name),
      INDEX idx_stp_territory_rep (rep_user_id, fiscal_year),
      CONSTRAINT fk_stp_territory_rep FOREIGN KEY (rep_user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  stp_accounts: `CREATE TABLE stp_accounts (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      territory_id BIGINT NOT NULL,
      fiscal_year SMALLINT UNSIGNED NOT NULL,
      customer_id BIGINT NULL,
      lead_id BIGINT NULL,
      prospect_name VARCHAR(200) NULL,
      segment VARCHAR(20) NOT NULL,
      annual_potential DECIMAL(15,2) NOT NULL DEFAULT 0,
      owner_user_id BIGINT NULL,
      visit_cadence VARCHAR(20) NOT NULL DEFAULT 'Monthly',
      last_visit_date DATE NULL,
      tier_override CHAR(1) NULL,
      tier_override_reason VARCHAR(500) NULL,
      tier_override_by_user_id BIGINT NULL,
      tier_override_at DATETIME NULL,
      notes TEXT NULL,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by_user_id BIGINT NULL,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_stp_account_customer (fiscal_year, customer_id),
      UNIQUE KEY uq_stp_account_lead (fiscal_year, lead_id),
      INDEX idx_stp_account_territory (territory_id),
      INDEX idx_stp_account_owner (owner_user_id),
      CONSTRAINT fk_stp_account_territory FOREIGN KEY (territory_id) REFERENCES stp_territories(id),
      CONSTRAINT fk_stp_account_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
      CONSTRAINT fk_stp_account_lead FOREIGN KEY (lead_id) REFERENCES leads(id),
      CONSTRAINT fk_stp_account_owner FOREIGN KEY (owner_user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  stp_visits: `CREATE TABLE stp_visits (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      account_id BIGINT NOT NULL,
      rep_user_id BIGINT NULL,
      visit_date DATE NOT NULL,
      notes VARCHAR(2000) NULL,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      INDEX idx_stp_visit_account (account_id, visit_date),
      CONSTRAINT fk_stp_visit_account FOREIGN KEY (account_id) REFERENCES stp_accounts(id) ON DELETE CASCADE,
      CONSTRAINT fk_stp_visit_rep FOREIGN KEY (rep_user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  stp_rep_capacity: `CREATE TABLE stp_rep_capacity (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      rep_user_id BIGINT NOT NULL,
      fiscal_year SMALLINT UNSIGNED NOT NULL,
      account_capacity INT UNSIGNED NOT NULL,
      notes VARCHAR(255) NULL,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by_user_id BIGINT NULL,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_stp_rep_capacity (rep_user_id, fiscal_year),
      CONSTRAINT fk_stp_capacity_rep FOREIGN KEY (rep_user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  stp_scoring_settings: `CREATE TABLE stp_scoring_settings (
      id TINYINT UNSIGNED PRIMARY KEY,
      window_months TINYINT UNSIGNED NOT NULL DEFAULT 12,
      weight_recency DECIMAL(5,2) NOT NULL DEFAULT 25,
      weight_frequency DECIMAL(5,2) NOT NULL DEFAULT 25,
      weight_volume DECIMAL(5,2) NOT NULL DEFAULT 25,
      weight_character DECIMAL(5,2) NOT NULL DEFAULT 25,
      recency_cutoffs JSON NOT NULL,
      frequency_cutoffs JSON NOT NULL,
      volume_cutoffs JSON NOT NULL,
      character_cutoffs JSON NOT NULL,
      character_overdue_cutoffs JSON NOT NULL,
      tier_a_min DECIMAL(3,2) NOT NULL DEFAULT 4.00,
      tier_b_min DECIMAL(3,2) NOT NULL DEFAULT 2.50,
      require_override_reason BOOLEAN NOT NULL DEFAULT TRUE,
      updated_by_user_id BIGINT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  stp_account_scores: `CREATE TABLE stp_account_scores (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      account_id BIGINT NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      window_months TINYINT UNSIGNED NOT NULL,
      is_prospect BOOLEAN NOT NULL DEFAULT FALSE,
      last_invoice_date DATE NULL,
      days_since_last_order INT NULL,
      order_count INT NULL,
      net_volume DECIMAL(15,2) NULL,
      avg_days_to_pay DECIMAL(7,1) NULL,
      avg_days_late DECIMAL(7,1) NULL,
      pct_on_time DECIMAL(5,1) NULL,
      overdue_balance DECIMAL(15,2) NULL,
      overdue_pct DECIMAL(9,1) NULL,
      recency_score TINYINT NULL,
      frequency_score TINYINT NULL,
      volume_score TINYINT NULL,
      character_score TINYINT NULL,
      character_source VARCHAR(10) NULL,
      total_score DECIMAL(4,2) NULL,
      computed_tier CHAR(1) NULL,
      warnings VARCHAR(100) NULL,
      calculated_by_user_id BIGINT NULL,
      calculated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_stp_score_account (account_id, id),
      INDEX idx_stp_score_calculated (calculated_at),
      CONSTRAINT fk_stp_score_account FOREIGN KEY (account_id) REFERENCES stp_accounts(id) ON DELETE CASCADE
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

// The single settings row, only if it is not there yet -- re-running never overwrites what an
// admin has changed.
async function seedSettings() {
  const row = settingsToRow(DEFAULT_SETTINGS);
  const [exists] = await pool.query("SHOW TABLES LIKE 'stp_scoring_settings'");
  if (DRY_RUN || !exists.length) { console.log(`~ would seed scoring defaults ${JSON.stringify(row)}`); return; }
  const cols = Object.keys(row);
  const [r] = await pool.query(
    `INSERT IGNORE INTO stp_scoring_settings (id, ${cols.join(', ')}) VALUES (1, ${cols.map(() => '?').join(', ')})`,
    Object.values(row));
  console.log(r.affectedRows ? '+ seeded scoring defaults' : '= scoring settings already set');
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
    if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get view + add + edit + delete`); continue; }
    if (existing) {
      await pool.query(
        'UPDATE user_page_permissions SET can_view = TRUE, can_add = TRUE, can_edit = TRUE, can_delete = TRUE WHERE id = ?', [existing.id]);
    } else {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete)
         VALUES (?, ?, TRUE, TRUE, TRUE, TRUE)`, [user.id, pageId]);
    }
    console.log(`  + ${user.display_name}: view + add + edit + delete`);
  }
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- nothing will be written.\n' : 'APPLYING changes.\n');
  await createTables();
  await seedSettings();
  await grantAdmins(await registerPage());
  await pool.end();
}

main().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
