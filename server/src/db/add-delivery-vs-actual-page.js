// Registers the Delivery Date Vs Actual report (/reports/delivery-vs-actual) -- every invoiced Job
// Order's delivery date against the day it was completed (its last Quality Inspection).
//
// Its view grant is carried over from whoever can view the Forecast Report, and System Admins get
// every action. Also indexes job_orders.delivery_date and quality_inspections.date_created, which it filters on.
//
// Idempotent. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/add-delivery-vs-actual-page.js
const pool = require('../db');
require('dotenv').config();

const ROUTE = '/reports/delivery-vs-actual';
const SOURCE = '/reports/forecast';

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);
  const [[source]] = await pool.query('SELECT id FROM pages WHERE route = ?', [SOURCE]);
  if (!source) throw new Error(`${SOURCE} is not registered, so its grants cannot be copied.`);

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) console.log(`Page ${ROUTE}: already registered (id ${page.id}).`);
  else {
    const [r] = await pool.query('INSERT INTO pages (route, name) VALUES (?, ?)', [ROUTE, 'Delivery Date Vs Actual']);
    page = { id: r.insertId };
    console.log(`Page ${ROUTE}: registered (id ${page.id}).`);
  }

  const [upp] = await pool.query(
    `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_print)
     SELECT src.user_id, ?, TRUE, TRUE FROM user_page_permissions src
      WHERE src.page_id = ? AND src.can_view = TRUE
        AND NOT EXISTS (SELECT 1 FROM (SELECT user_id FROM user_page_permissions WHERE page_id = ?) e WHERE e.user_id = src.user_id)`,
    [page.id, source.id, page.id]);
  console.log(`  user_page_permissions: ${upp.affectedRows} view grant(s) carried over from ${SOURCE}.`);

  const [atp] = await pool.query(
    `INSERT INTO account_type_permissions (account_type, page_id, can_view, can_print, updated_at)
     SELECT src.account_type, ?, TRUE, TRUE, NOW() FROM account_type_permissions src
      WHERE src.page_id = ? AND src.can_view = TRUE
        AND NOT EXISTS (SELECT 1 FROM (SELECT account_type FROM account_type_permissions WHERE page_id = ?) e WHERE e.account_type = src.account_type)`,
    [page.id, source.id, page.id]);
  console.log(`  account_type_permissions: ${atp.affectedRows} template row(s) carried over.`);

  await pool.query(
    `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print)
     SELECT u.id, ?, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE FROM users u
      WHERE u.account_type = 'System Admin'
        AND NOT EXISTS (SELECT 1 FROM (SELECT user_id FROM user_page_permissions WHERE page_id = ?) e WHERE e.user_id = u.id)`,
    [page.id, page.id]);

  const [idx] = await pool.query("SHOW INDEX FROM job_orders WHERE Key_name = 'idx_job_orders_delivery_date'");
  if (!idx.length) {
    await pool.query('ALTER TABLE job_orders ADD INDEX idx_job_orders_delivery_date (delivery_date)');
    console.log('  index job_orders(delivery_date) added.');
  } else console.log('  index job_orders(delivery_date) already present.');
  const [qix] = await pool.query("SHOW INDEX FROM quality_inspections WHERE Key_name = 'idx_qi_date_created'");
  if (!qix.length) {
    await pool.query('ALTER TABLE quality_inspections ADD INDEX idx_qi_date_created (date_created)');
    console.log('  index quality_inspections(date_created) added.');
  } else console.log('  index quality_inspections(date_created) already present.');
  await pool.end();
}
main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
