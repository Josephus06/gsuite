// BIR 2307 to suppliers (asked 2026-11-05): Accounting generates and prints the BIR Form 2307
// (Certificate of Creditable Tax Withheld at Source, January 2018 ENCS) for each supplier we
// withheld Expanded Withholding Tax from in a quarter -- the payor's side of the 2307. (The
// Creditable Withholding Tax page is the other side: the 2307s our CUSTOMERS owe us.)
//
//   /reports/bir-2307   BIR 2307 to Suppliers   View: list a quarter's suppliers and open a form
//                                               Print: print it (each print is logged)
//                                               Edit: change the Payor details printed in Part II
//
// supplier_2307_issuances: one row per certificate printed (supplier, quarter, totals, who, when),
// so the page shows which suppliers have had theirs.
// app_settings bir_payor_*: the Payor's TIN, name, address, ZIP and signatory, seeded blank here
// and filled from the page.
//
// System Admins get View, Print and Edit. Grant Accounting from Users & Permissions. Idempotent.
//   node src/db/add-bir-2307-issue.js --dry-run
//   node src/db/add-bir-2307-issue.js
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const PAGE = { route: '/reports/bir-2307', name: 'BIR 2307 to Suppliers' };
const SETTINGS = ['bir_payor_tin', 'bir_payor_name', 'bir_payor_address', 'bir_payor_zip',
  'bir_payor_signatory', 'bir_payor_signatory_title', 'bir_payor_signatory_tin'];

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY ? ' -- DRY RUN' : ''}\n`);
  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  const hasModule = cols.some((c) => c.Field === 'module');
  const [permCols] = await pool.query('SHOW COLUMNS FROM user_page_permissions');
  const hasPrint = permCols.some((c) => c.Field === 'can_print');
  const [admins] = await pool.query("SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = 1");

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [PAGE.route]);
  if (page) console.log(`= ${PAGE.route} already registered (id ${page.id})`);
  else if (DRY) console.log(`~ would register ${PAGE.route} "${PAGE.name}"`);
  else {
    const [r] = await pool.query(
      `INSERT INTO pages (route, name${hasModule ? ', module' : ''}) VALUES (?, ?${hasModule ? ', ?' : ''})`,
      hasModule ? [PAGE.route, PAGE.name, 'BIR Reports'] : [PAGE.route, PAGE.name]);
    page = { id: r.insertId };
    console.log(`+ registered ${PAGE.route} "${PAGE.name}" (id ${page.id})`);
  }
  if (page) {
    for (const u of admins) {
      const [[ex]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [u.id, page.id]);
      if (DRY) { console.log(`  ~ ${u.display_name}`); continue; }
      const sets = ['can_view = 1', 'can_edit = 1'];
      if (hasPrint) sets.push('can_print = 1');
      if (ex) await pool.query(`UPDATE user_page_permissions SET ${sets.join(', ')} WHERE id = ?`, [ex.id]);
      else {
        await pool.query(
          `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_edit${hasPrint ? ', can_print' : ''})
           VALUES (?, ?, 1, 1${hasPrint ? ', 1' : ''})`, [u.id, page.id]);
      }
      console.log(`  + ${u.display_name}`);
    }
  }

  const [[t]] = await pool.query(
    "SELECT 1 AS ok FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'supplier_2307_issuances'");
  if (t) console.log('\n= supplier_2307_issuances already exists');
  else if (DRY) console.log('\n~ would create supplier_2307_issuances');
  else {
    await pool.query(`CREATE TABLE supplier_2307_issuances (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        payee_key VARCHAR(220) NOT NULL,
        supplier_id BIGINT NULL,
        payee_name VARCHAR(200) NULL,
        quarter CHAR(7) NOT NULL,
        income_total DECIMAL(15,2) NOT NULL DEFAULT 0,
        tax_total DECIMAL(15,2) NOT NULL DEFAULT 0,
        issued_by_user_id INT NULL,
        issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_2307_issue_quarter (quarter, payee_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('\n+ created supplier_2307_issuances');
  }

  // 2026-11-05 (later): a 2307 can be for chosen documents (one bill) and for a period other than
  // the quarter -- the log keeps both. Added to a table created by the first version too.
  if (t || !DRY) {
    const [ic] = await pool.query('SHOW COLUMNS FROM supplier_2307_issuances');
    const have = new Set(ic.map((c) => c.Field));
    for (const [col, def] of [['period_from', 'DATE NULL AFTER quarter'], ['period_to', 'DATE NULL AFTER period_from'], ['doc_refs', 'VARCHAR(1000) NULL AFTER period_to']]) {
      if (have.has(col)) continue;
      if (DRY) { console.log(`~ would add supplier_2307_issuances.${col}`); continue; }
      await pool.query(`ALTER TABLE supplier_2307_issuances ADD COLUMN ${col} ${def}`);
      console.log(`+ supplier_2307_issuances.${col}`);
    }
  }

  for (const k of SETTINGS) {
    const [[s]] = await pool.query('SELECT name FROM app_settings WHERE name = ?', [k]);
    if (s) continue;
    if (DRY) { console.log(`~ would add app_settings ${k}`); continue; }
    await pool.query('INSERT INTO app_settings (name, value) VALUES (?, ?)', [k, '']);
    console.log(`+ app_settings ${k}`);
  }
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
