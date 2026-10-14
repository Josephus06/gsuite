// A Check Voucher (cheque) or Fund Transfer Voucher raised from an approved Fund Transfer Request
// (Forms) -- the "Create Check Voucher" / "Create Fund Transfer Voucher" buttons on the form (asked
// 2026-10-14). Each voucher carries the request it posts, so the form lists them and stops offering
// the buttons once they cover its total.
//
//   cheques.form_request_id          (new)  the Fund Transfer Request this cheque posts, else NULL
//   fund_transfers.form_request_id   (new)  the Fund Transfer Request this transfer posts, else NULL
//
// The routes write the column only when it exists, so code and schema deploy in either order.
//
// Idempotent. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/add-fund-transfer-request-link.js
const pool = require('../db');

const TABLES = [
  { table: 'cheques', index: 'idx_cheques_form_request' },
  { table: 'fund_transfers', index: 'idx_fund_transfers_form_request' },
];

async function main() {
  for (const { table, index } of TABLES) {
    const [col] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE 'form_request_id'`);
    if (col.length) console.log(`${table}.form_request_id already exists.`);
    else {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN form_request_id BIGINT NULL`);
      console.log(`Added ${table}.form_request_id.`);
    }
    const [idx] = await pool.query(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [index]);
    if (idx.length) console.log(`${index} already exists.`);
    else {
      await pool.query(`ALTER TABLE ${table} ADD INDEX ${index} (form_request_id)`);
      console.log(`Added index ${index}.`);
    }
  }
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
