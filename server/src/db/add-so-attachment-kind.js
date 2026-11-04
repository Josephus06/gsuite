// Document type on sales order attachments (2026-11-04), so Pending Billing can tick "wt PO" when the
// order has its PO attached. Files already on orders stay untyped (NULL).
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
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
