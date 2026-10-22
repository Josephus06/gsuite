// Forms: the requestor chooses who approves and who notes each form (asked 2026-10-22).
//
//   form_requests.approver_user_id  required on every form saved from now on; the form picker
//                                   defaults it to the General Manager
//   form_requests.noter_user_id     optional -- none, and a submitted form goes straight to For
//                                   Approval
//
// Forms already in progress (no approver chosen) keep the routing they were filed under.
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-form-chosen-approvers.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const [col, ddl] of [
    ['approver_user_id', 'ADD COLUMN approver_user_id BIGINT NULL, ADD KEY idx_form_approver (approver_user_id)'],
    ['noter_user_id', 'ADD COLUMN noter_user_id BIGINT NULL, ADD KEY idx_form_noter (noter_user_id)'],
  ]) {
    const [c] = await pool.query(`SHOW COLUMNS FROM form_requests LIKE '${col}'`);
    if (c.length) { console.log(`= form_requests.${col} already present`); continue; }
    await pool.query(`ALTER TABLE form_requests ${ddl}`);
    console.log(`+ added form_requests.${col}`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
