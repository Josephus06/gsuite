// Sales Order Cancel (System Admin, asked 2026-10-03): why and by whom an order was cancelled.
//   sales_orders.cancel_reason_id  -> reasons.id (Master Lists > Reasons, type "Cancellation")
//   sales_orders.cancel_remarks, cancelled_at, cancelled_by_user_id
// Safe to re-run.
//
//   node src/db/add-sales-order-cancel-reason.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const COLUMNS = [
  ['cancel_reason_id', 'INT NULL'],
  ['cancel_remarks', 'VARCHAR(500) NULL'],
  ['cancelled_at', 'DATETIME NULL'],
  ['cancelled_by_user_id', 'INT NULL'],
];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const [name, type] of COLUMNS) {
    const [[c]] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'sales_orders' AND column_name = ?`, [name]);
    if (c.n) { console.log(`sales_orders.${name} already present`); continue; }
    await pool.query(`ALTER TABLE sales_orders ADD COLUMN ${name} ${type}`);
    console.log(`added sales_orders.${name}`);
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
