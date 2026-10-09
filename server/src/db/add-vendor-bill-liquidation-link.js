// A Vendor Bill raised from an approved Liquidation (Forms) -- Create Vendor Bill on the form
// (asked 2026-10-09). The bill carries the liquidation it came from, so the form can show its bill
// and refuse a second one. The liquidation itself no longer posts to the GL; its bill does.
//
//   vendor_bills.form_request_id   (new)   the liquidation this bill was raised from, else NULL
//
// Idempotent. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/add-vendor-bill-liquidation-link.js
const pool = require('../db');

async function main() {
  const [col] = await pool.query("SHOW COLUMNS FROM vendor_bills LIKE 'form_request_id'");
  if (col.length) console.log('vendor_bills.form_request_id already exists.');
  else {
    await pool.query('ALTER TABLE vendor_bills ADD COLUMN form_request_id BIGINT NULL AFTER supplier_id');
    console.log('Added vendor_bills.form_request_id.');
  }
  const [idx] = await pool.query("SHOW INDEX FROM vendor_bills WHERE Key_name = 'idx_vendor_bills_form_request'");
  if (idx.length) console.log('idx_vendor_bills_form_request already exists.');
  else {
    await pool.query('ALTER TABLE vendor_bills ADD INDEX idx_vendor_bills_form_request (form_request_id)');
    console.log('Added index idx_vendor_bills_form_request.');
  }
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
