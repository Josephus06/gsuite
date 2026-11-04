// Pending Billing's "wt PAR&Pics" / "wt PO" (2026-11-04):
//   - a document type on sales order attachments, so "wt PO" ticks when the order has its PO attached
//     (files already on orders stay untyped, NULL);
//   - pending_billing_marks, the boxes ticked by hand by a user with can_update on Pending Billing.
//   node src/db/add-so-attachment-kind.js
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  const [[c]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_order_attachments' AND COLUMN_NAME = 'kind'`);
  if (c.n) console.log('sales_order_attachments.kind exists');
  else {
    await pool.query('ALTER TABLE sales_order_attachments ADD COLUMN kind VARCHAR(40) NULL AFTER sales_order_id, ADD KEY idx_so_attachment_kind (sales_order_id, kind)');
    console.log('Added sales_order_attachments.kind');
  }
  // target 'par' = a job order id, 'po' = a sales order id (a PO belongs to the whole order).
  await pool.query(`CREATE TABLE IF NOT EXISTS pending_billing_marks (
      target VARCHAR(10) NOT NULL,
      target_id BIGINT NOT NULL,
      marked_by_user_id BIGINT DEFAULT NULL,
      marked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (target, target_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  console.log('pending_billing_marks ready');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
