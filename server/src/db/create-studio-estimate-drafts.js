// "Create Estimate" from the Signage Studio (routes/studioEstimates.js, client EstimateWizard
// ?studio_draft=). Agreed with the user 2026-11-25:
//
//   The studio's Create Estimate button (inside a project, its creator or an admin, the revision's
//   Check at 0 errors) sends the project to T1S as a DRAFT, then opens /estimates/new?studio_draft=
//   <id>. The Estimate form fills itself from the draft -- customer, project, one job line (job type
//   mapped from the sign category, size in mm), and the BOM as material lines -- and nothing is
//   saved until the user goes on as with any estimate. T1S prices every line; labour and
//   installation are added by Sales.
//
//   BOM: one line per T1S item. Sheets as whole sheets (pieces x the sheet's mm size), lengths in
//   mm, everything else by count. MILLIMETRES ONLY from the studio; T1S's own pricing converts.
//
// Tables:
//   studio_estimate_drafts        one per Create Estimate click (public_id is what the URL carries)
//   studio_estimate_draft_files   the render and the drawing set PDF, copied onto the estimate
//   studio_category_job_types     sign category (studio code) -> T1S Job Type, kept by an admin
// Process "3D Studio - Materials" (3DS-MATERIALS): no cost brackets, so its process price is 0 and
// a BOM line under it carries the material only.
// Permission page /3d-studio/job-types ("3D Studio Job Types") for the mapping; System Admins get it.
//
// Idempotent. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/create-studio-estimate-drafts.js --dry-run
//   node src/db/create-studio-estimate-drafts.js
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const PAGE_ROUTE = '/3d-studio/job-types';
const PAGE_NAME = '3D Studio Job Types';
const PROCESS_CODE = '3DS-MATERIALS';
const PROCESS_NAME = '3D Studio - Materials';

const TABLES = {
  studio_estimate_drafts: `CREATE TABLE studio_estimate_drafts (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      public_id CHAR(36) NOT NULL,
      studio_project_id VARCHAR(64) NOT NULL,
      project_number VARCHAR(40) NULL,
      project_title VARCHAR(200) NOT NULL,
      revision_id VARCHAR(64) NULL,
      revision_label VARCHAR(100) NULL,
      category_code VARCHAR(40) NULL,
      category_name VARCHAR(80) NULL,
      customer_erp_id BIGINT NULL,
      customer_name VARCHAR(200) NULL,
      site_address TEXT NULL,
      quantity DECIMAL(12,2) NOT NULL DEFAULT 1,
      length_mm DECIMAL(12,1) NULL,
      width_mm DECIMAL(12,1) NULL,
      height_mm DECIMAL(12,1) NULL,
      bom JSON NOT NULL,
      led_summary JSON NULL,
      studio_user_name VARCHAR(150) NULL,
      t1s_user_id BIGINT NULL,
      estimate_id BIGINT NULL,
      used_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_studio_draft_public (public_id),
      INDEX idx_studio_draft_project (studio_project_id),
      INDEX idx_studio_draft_estimate (estimate_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  studio_estimate_draft_files: `CREATE TABLE studio_estimate_draft_files (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      draft_id BIGINT NOT NULL,
      kind VARCHAR(20) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      size_bytes INT NOT NULL,
      file_data LONGBLOB NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_studio_draft_file (draft_id),
      CONSTRAINT fk_studio_draft_file FOREIGN KEY (draft_id) REFERENCES studio_estimate_drafts(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  studio_category_job_types: `CREATE TABLE studio_category_job_types (
      category_code VARCHAR(40) PRIMARY KEY,
      category_name VARCHAR(80) NULL,
      job_type_id BIGINT NULL,
      updated_by_user_id BIGINT NULL,
      updated_at DATETIME NULL
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

// Unit LOT, and the Default Location most Signage processes use: an estimate process line refuses
// to save without a location.
async function createMaterialsProcess() {
  const [[existing]] = await pool.query('SELECT id FROM processes WHERE process_code = ?', [PROCESS_CODE]);
  if (existing) { console.log(`= process ${PROCESS_CODE} already exists (id ${existing.id})`); return; }
  const [[unit]] = await pool.query("SELECT id FROM units_of_measure WHERE code = 'LOT' LIMIT 1");
  const [[loc]] = await pool.query(
    `SELECT default_location_id AS id, COUNT(*) AS n FROM processes
      WHERE process_name LIKE 'Signage%' AND default_location_id IS NOT NULL
      GROUP BY default_location_id ORDER BY n DESC LIMIT 1`);
  if (!unit) throw new Error('No LOT unit of measure -- cannot create the materials process');
  if (DRY_RUN) { console.log(`~ would create process ${PROCESS_CODE} "${PROCESS_NAME}" (LOT, location ${loc?.id ?? 'none'}, price 0)`); return; }
  const [r] = await pool.query(
    'INSERT INTO processes (process_code, process_name, base_unit_id, default_location_id, is_active) VALUES (?, ?, ?, ?, 1)',
    [PROCESS_CODE, PROCESS_NAME, unit.id, loc?.id || null]);
  console.log(`+ created process ${PROCESS_CODE} "${PROCESS_NAME}" (id ${r.insertId})`);
}

async function registerPage() {
  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [PAGE_ROUTE]);
  if (existing) { console.log(`= page ${PAGE_ROUTE} already registered (id ${existing.id})`); return existing.id; }
  if (DRY_RUN) { console.log(`~ would register ${PAGE_ROUTE} as "${PAGE_NAME}"`); return null; }
  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  const has = new Set(cols.map((c) => c.Field));
  const fields = ['route', 'name'];
  const values = [PAGE_ROUTE, PAGE_NAME];
  if (has.has('module')) { fields.push('module'); values.push('Sales'); }
  const [result] = await pool.query(`INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values);
  console.log(`+ registered ${PAGE_ROUTE} as "${PAGE_NAME}" (id ${result.insertId})`);
  return result.insertId;
}

async function grantAdmins(pageId) {
  if (!pageId) return;
  const [admins] = await pool.query("SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const user of admins) {
    const [[existing]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, pageId]);
    if (existing) {
      await pool.query('UPDATE user_page_permissions SET can_view = TRUE, can_edit = TRUE WHERE id = ?', [existing.id]);
    } else {
      await pool.query('INSERT INTO user_page_permissions (user_id, page_id, can_view, can_edit) VALUES (?, ?, TRUE, TRUE)', [user.id, pageId]);
    }
    console.log(`  + ${user.display_name}: view + edit`);
  }
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- nothing will be written.\n' : 'APPLYING changes.\n');
  await createTables();
  await createMaterialsProcess();
  await grantAdmins(await registerPage());
  await pool.end();
}

main().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
