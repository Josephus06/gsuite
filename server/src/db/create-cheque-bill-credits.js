// cheque_bill_credits -- a vendor's open Bill Credits used up on a Cheque to that vendor
// (2026-10-01). Each row takes applied_amount off the credit (bill_credits.applied_amount, as a
// Bill Payment's credit lines do) and off the cheque's cash: the cheque posts CR the credit's AP
// account for it (lib/glImpact.js computeChequeGl). Voiding or editing the cheque gives it back.
//
//   node src/db/create-cheque-bill-credits.js
// Idempotent. Droplet and office replicate: run on the droplet, then confirm on the office box.
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [t] = await pool.query("SHOW TABLES LIKE 'cheque_bill_credits'");
  if (t.length) console.log('cheque_bill_credits already present.');
  else {
    await pool.query(`
      CREATE TABLE cheque_bill_credits (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        cheque_id BIGINT NOT NULL,
        bill_credit_id BIGINT NOT NULL,
        applied_amount DECIMAL(16,2) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_cbc_cheque (cheque_id),
        KEY idx_cbc_credit (bill_credit_id)
      )`);
    console.log('Created cheque_bill_credits.');
  }
  await pool.end();
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
