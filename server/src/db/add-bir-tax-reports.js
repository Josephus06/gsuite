// BIR Reports enhancement (asked 2026-10-21): three more pages beside Sales Report and Purchase
// Report, and the table that records a customer's BIR 2307 as received.
//
//   /reports/bir-ewt  Expanded Withholding Tax   what we withheld from suppliers, by ATC -- due the 5th
//   /reports/bir-cwt  Creditable Withholding Tax the 2307s our customers owe us -- collected by month end
//   /reports/bir-vat  VAT Computation            Output Tax less Input Tax -- due the 15th
//
// customer_2307_receipts: one row per invoice whose 2307 has come in (date, certificate no., who
// recorded it). Its own table rather than columns on sales_invoices (74k rows): no ALTER on the big
// table, and an invoice with no row simply has not been received.
//
// System Admins get View, Print and (on the 2307 page, to mark certificates received) Edit. Grant
// Accounting from Users & Permissions afterwards. Idempotent.
//   node src/db/add-bir-tax-reports.js --dry-run
//   node src/db/add-bir-tax-reports.js
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const MODULE = 'BIR Reports';
const PAGES = [
  { route: '/reports/bir-ewt', name: 'Expanded Withholding Tax' },
  { route: '/reports/bir-cwt', name: 'Creditable Withholding Tax (2307)', edit: true },
  { route: '/reports/bir-vat', name: 'VAT Computation' },
];

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY ? ' -- DRY RUN' : ''}\n`);
  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  const hasModule = cols.some((c) => c.Field === 'module');
  const [permCols] = await pool.query('SHOW COLUMNS FROM user_page_permissions');
  const hasPrint = permCols.some((c) => c.Field === 'can_print');
  const [admins] = await pool.query("SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = 1");

  for (const p of PAGES) {
    let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [p.route]);
    if (page) console.log(`= ${p.route} already registered (id ${page.id})`);
    else if (DRY) console.log(`~ would register ${p.route} "${p.name}"`);
    else {
      const [r] = await pool.query(
        `INSERT INTO pages (route, name${hasModule ? ', module' : ''}) VALUES (?, ?${hasModule ? ', ?' : ''})`,
        hasModule ? [p.route, p.name, MODULE] : [p.route, p.name]);
      page = { id: r.insertId };
      console.log(`+ registered ${p.route} "${p.name}" (id ${page.id})`);
    }
    if (!page) continue;
    for (const u of admins) {
      const [[ex]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [u.id, page.id]);
      if (DRY) { console.log(`  ~ ${u.display_name}`); continue; }
      const sets = ['can_view = 1'];
      if (hasPrint) sets.push('can_print = 1');
      if (p.edit) sets.push('can_edit = 1');
      if (ex) await pool.query(`UPDATE user_page_permissions SET ${sets.join(', ')} WHERE id = ?`, [ex.id]);
      else {
        await pool.query(
          `INSERT INTO user_page_permissions (user_id, page_id, can_view${hasPrint ? ', can_print' : ''}${p.edit ? ', can_edit' : ''})
           VALUES (?, ?, 1${hasPrint ? ', 1' : ''}${p.edit ? ', 1' : ''})`, [u.id, page.id]);
      }
      console.log(`  + ${u.display_name}`);
    }
  }

  const [[t]] = await pool.query(
    "SELECT 1 AS ok FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customer_2307_receipts'");
  if (t) console.log('\n= customer_2307_receipts already exists');
  else if (DRY) console.log('\n~ would create customer_2307_receipts');
  else {
    const [[col]] = await pool.query(
      "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_invoices' AND COLUMN_NAME = 'id'");
    await pool.query(`CREATE TABLE customer_2307_receipts (
        sales_invoice_id ${col.t} NOT NULL PRIMARY KEY,
        received_date DATE NOT NULL,
        certificate_no VARCHAR(100) NULL,
        remarks VARCHAR(500) NULL,
        received_by_user_id INT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_2307_received (received_date),
        CONSTRAINT fk_2307_invoice FOREIGN KEY (sales_invoice_id) REFERENCES sales_invoices(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('\n+ created customer_2307_receipts');
  }
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
