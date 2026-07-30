// One-off migration: creates the Office Supply Requisition (OSR-####) tables and registers its page
// under Inventory. An OSR is a transfer-order-like withdrawal of OFFICE-SUPPLY items from a
// location: you request items (only inventory flagged is_office_supply) with a qty, then Fulfill it
// to serve those qtys and draw them down from on-hand stock. Simpler than a Transfer Order -- one
// location, no separate fulfillment/receipt/transit documents.
//
//   node src/db/create-osr.js --dry-run
//   node src/db/create-osr.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const PAGES = [{ route: '/office-supply-requisitions', name: 'Office Supply Requisition', module: 'Inventory' }];

const TABLES = [
  ['office_supply_requisitions', `
CREATE TABLE office_supply_requisitions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    osr_no VARCHAR(40) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    date_needed DATE NULL,
    location_id BIGINT NULL,
    requestor_id BIGINT NULL,
    department_id BIGINT NULL,
    memo VARCHAR(1000) NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'open',
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    fulfilled_by_user_id BIGINT NULL,
    fulfilled_at DATETIME NULL,
    cancelled_at DATETIME NULL,
    INDEX idx_osr_status (status),
    INDEX idx_osr_date (date_created)
)`],
  ['office_supply_requisition_lines', `
CREATE TABLE office_supply_requisition_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    osr_id BIGINT NOT NULL,
    line_no INT NOT NULL,
    item_id BIGINT NULL,
    location_id BIGINT NULL,
    qty DECIMAL(16,4) NOT NULL DEFAULT 0,
    qty_served DECIMAL(16,4) NOT NULL DEFAULT 0,
    uom VARCHAR(50) NULL,
    category VARCHAR(100) NULL,
    remarks VARCHAR(500) NULL,
    INDEX idx_osrl_parent (osr_id)
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
