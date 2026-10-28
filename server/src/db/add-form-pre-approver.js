// Forms > Liquidation: a Pre-approver (asked 2026-10-28) -- a third person the requestor may choose,
// besides the Noter and the Approver. When one is chosen the liquidation runs
//   For Noting -> (noted) -> For Pre-Approval -> (pre-approved) -> For Approval -> Approved
// and the Approver cannot approve it until it is pre-approved. Optional: with none it runs as before.
//
//   form_requests.pre_approver_user_id  who the requestor chose
//   form_requests.pre_approved_at / pre_approved_by  when and by whom (cleared when it is rejected,
//                                         so a revised form is pre-approved again)
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-form-pre-approver.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [cols] = await pool.query('SHOW COLUMNS FROM form_requests');
  const has = new Set(cols.map((c) => c.Field));
  for (const [col, ddl] of [
    ['pre_approver_user_id', 'ADD COLUMN pre_approver_user_id BIGINT NULL'],
    ['pre_approved_at', 'ADD COLUMN pre_approved_at DATETIME NULL'],
    ['pre_approved_by', 'ADD COLUMN pre_approved_by BIGINT NULL'],
  ]) {
    if (has.has(col)) { console.log(`  form_requests.${col} already there`); continue; }
    await pool.query(`ALTER TABLE form_requests ${ddl}`);
    console.log(`  form_requests.${col} added`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
