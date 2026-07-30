// One-off migration: creates the Non-Standard Sales Order (NSSO) tables and registers its page
// under the Sales module. An NSSO is a sales-order-like document raised outside the normal
// Estimate -> Sales Order path, in one of four types, each with its own "nesting":
//   RMA              -> nested to a Sales Order that has a Completed job order (redo/return)
//   RMA - Installation -> nested to any Sales Order regardless of JO status
//   Sample           -> nested to an approved Estimate
//   Internal         -> no nesting (like a standard SO; job type chosen up front, processes/items
//                       added after approval)
// Doc number is NSSO-<TYPE>-#### (RMA/INST/SAM/INT). It carries its own job-order lines.
//
// The page is registered and admins granted full access in this same migration, so it can never
// be left unreachable (requirePermission resolves a route to a page before checking).
//
//   node src/db/create-non-standard-sales-orders.js --dry-run
//   node src/db/create-non-standard-sales-orders.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const PAGES = [{ route: '/non-standard-sales-orders', name: 'NSSO', module: 'Sales' }];

const TABLES = [
  ['non_standard_sales_orders', `
CREATE TABLE non_standard_sales_orders (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    nsso_no VARCHAR(40) UNIQUE NOT NULL,
    type VARCHAR(30) NOT NULL,
    date_created DATE NOT NULL,
    customer_id BIGINT NULL,
    contact_person_id BIGINT NULL,
    contact_email VARCHAR(255) NULL,
    contact_title VARCHAR(100) NULL,
    contact_phone VARCHAR(100) NULL,
    sales_rep_id BIGINT NULL,
    sales_division_id BIGINT NULL,
    office_location_id BIGINT NULL,
    contract_description VARCHAR(500) NULL,
    memo VARCHAR(1000) NULL,
    shipping_address VARCHAR(500) NULL,
    has_multiple_shipping TINYINT NOT NULL DEFAULT 0,
    nested_sales_order_id BIGINT NULL,
    nested_estimate_id BIGINT NULL,
    production_lead_time VARCHAR(100) NULL,
    print_warranty TINYINT NOT NULL DEFAULT 0,
    print_warranty_term VARCHAR(100) NULL,
    structure_warranty TINYINT NOT NULL DEFAULT 0,
    structure_warranty_term VARCHAR(100) NULL,
    electrical_warranty TINYINT NOT NULL DEFAULT 0,
    electrical_warranty_term VARCHAR(100) NULL,
    prepared_by_id BIGINT NULL,
    approved_by_id BIGINT NULL,
    status VARCHAR(40) NOT NULL DEFAULT 'pending_approval',
    subtotal DECIMAL(16,2) NOT NULL DEFAULT 0,
    net_of_tax DECIMAL(16,2) NOT NULL DEFAULT 0,
    tax_total DECIMAL(16,2) NOT NULL DEFAULT 0,
    total_amount DECIMAL(16,2) NOT NULL DEFAULT 0,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    approved_at DATETIME NULL,
    cancelled_at DATETIME NULL,
    cancelled_by_user_id BIGINT NULL,
    INDEX idx_nsso_type (type),
    INDEX idx_nsso_customer (customer_id),
    INDEX idx_nsso_nested_so (nested_sales_order_id)
)`],
  ['non_standard_sales_order_lines', `
CREATE TABLE non_standard_sales_order_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    nsso_id BIGINT NOT NULL,
    line_no INT NOT NULL,
    job_type_id BIGINT NULL,
    job_location_id BIGINT NULL,
    description VARCHAR(500) NULL,
    quantity DECIMAL(16,4) NOT NULL DEFAULT 0,
    units VARCHAR(50) NULL,
    price_per_unit DECIMAL(16,4) NOT NULL DEFAULT 0,
    subtotal DECIMAL(16,2) NOT NULL DEFAULT 0,
    disc_percent DECIMAL(8,4) NOT NULL DEFAULT 0,
    disc_amount DECIMAL(16,2) NOT NULL DEFAULT 0,
    net_of_tax DECIMAL(16,2) NOT NULL DEFAULT 0,
    tax_code_id BIGINT NULL,
    tax_amount DECIMAL(16,2) NOT NULL DEFAULT 0,
    gross_amount DECIMAL(16,2) NOT NULL DEFAULT 0,
    length DECIMAL(16,4) NULL,
    width DECIMAL(16,4) NULL,
    height DECIMAL(16,4) NULL,
    uom VARCHAR(50) NULL,
    remarks VARCHAR(500) NULL,
    memo VARCHAR(500) NULL,
    delivery_date DATE NULL,
    source_job_order_id BIGINT NULL,
    INDEX idx_nssol_parent (nsso_id)
)`],
];

async function tableExists(name) { const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]); return rows.length > 0; }

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
      const fields = ['route', 'name']; const values = [p.route, p.name];
      if (has.has('module')) { fields.push('module'); values.push(p.module); }
      const [result] = await pool.query(`INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values);
      page = { id: result.insertId };
      console.log(`\nRegistered ${p.route} as "${p.name}" (id ${page.id}).`);
    }
    if (!page) continue;
    for (const user of admins) {
      const [[existing]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id]);
      if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get full access.`); continue; }
      if (existing) await pool.query('UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE WHERE id = ?', [existing.id]);
      else await pool.query('INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve) VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)', [user.id, page.id]);
      console.log(`  + ${user.display_name}: full access.`);
    }
  }
  await pool.end();
}
main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
