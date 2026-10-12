// Which Liquidation items each Vendor Bill posts (2026-10-12), so one liquidation can be billed on
// more than one bill -- receipts from different vendors -- each item on exactly one of them.
// A bill raised from a liquidation before this table existed has no rows here and is read as
// posting every item of its liquidation (lib/liquidationPosting.js), as it did.
//
// Idempotent. Run before deploying the code that uses it.
//   node src/db/add-vendor-bill-form-items.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendor_bill_form_items (
      vendor_bill_id BIGINT NOT NULL,
      form_request_item_id BIGINT NOT NULL,
      PRIMARY KEY (vendor_bill_id, form_request_item_id),
      KEY idx_vbfi_item (form_request_item_id)
    )`);
  console.log('vendor_bill_form_items ready.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
