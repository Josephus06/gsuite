// One-off migration: creates the transaction_settings master table and registers its page under
// Master Lists. Mirrors the live "Transaction Settings" screen -- one row per transaction type with
// an "Is Posting" flag (whether it posts to the ledger) and a display sequence. Seeded verbatim from
// live (get_transaction_settings, 38 rows).
//
//   node src/db/create-transaction-settings.js --dry-run
//   node src/db/create-transaction-settings.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const PAGES = [{ route: '/transaction-settings', name: 'Transaction Settings', module: 'Master Lists' }];

// [seq, name, is_posting] -- exact live values.
const SEED = [
  [1, 'Estimate', 0], [2, 'Sales Order', 0], [3, 'Job Order', 0], [4, 'RWIP', 0], [5, 'RFQC', 0], [6, 'RMA', 0],
  [7, 'Quality Inspection', 0], [8, 'Transfer Order', 0], [9, 'Office Supply Requisition', 0], [10, 'Purchase Requisition', 0],
  [11, 'Purchase Order', 0], [12, 'Non-Standard Sales Order - Internal', 0], [13, 'Non-Standard Sales Order - Sample', 0],
  [14, 'Non-Standard Sales Order - RMA', 0], [15, 'Non-Standard Job Order', 0], [16, 'Non-Standard Job Order - Internal', 0],
  [17, 'Non-Standard Job Order - Sample', 0], [18, 'Non-Standard Job Order - RMA', 0], [20, 'Item Fulfillment', 1],
  [22, 'Item Receipt', 1], [24, 'Inventory Adjustment', 1], [27, 'Assembly Build', 1], [29, 'Item Delivery', 1],
  [31, 'Invoice', 1], [32, 'Delivery Ticket', 1], [34, 'Credit Memo', 1], [37, 'Payment', 1], [39, 'Deposit', 1],
  [41, 'Customer Refund', 1], [43, 'Receiving Report', 1], [45, 'Bill', 1], [48, 'Vendor Return', 1], [50, 'Bill Credit', 1],
  [58, 'Bill Payment', 1], [60, 'Cheque', 1], [63, 'Office Supply Fulfillment', 1], [65, 'Fund Transfer', 1], [67, 'Journal', 1],
];

async function tableExists(name) { const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]); return rows.length > 0; }

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  if (await tableExists('transaction_settings')) console.log('Table transaction_settings already exists.');
  else if (DRY_RUN) console.log('Would create table transaction_settings.');
  else {
    await pool.query(`
CREATE TABLE transaction_settings (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    transaction_name VARCHAR(120) UNIQUE NOT NULL,
    is_posting TINYINT NOT NULL DEFAULT 0,
    seq INT NOT NULL DEFAULT 0,
    updated_at DATETIME NULL,
    updated_by_user_id BIGINT NULL
)`);
    for (const [seq, name, posting] of SEED) {
      await pool.query('INSERT IGNORE INTO transaction_settings (transaction_name, is_posting, seq) VALUES (?, ?, ?)', [name, posting, seq]);
    }
    console.log(`Created transaction_settings and seeded ${SEED.length} rows.`);
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
