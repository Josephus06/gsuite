// Files attached to a form -- every type (asked 2026-10-07): a receipt behind a liquidation, a
// billing behind a Request for Payment, a bank slip behind a Fund Transfer Request Form. Stored in
// the row like every other attachment in this system (job_order_attachments, ticket_attachments).
//
//   node src/db/add-form-attachments.js
// Safe to re-run. Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [rows] = await pool.query("SHOW TABLES LIKE 'form_request_attachments'");
  if (rows.length) {
    console.log('  form_request_attachments already there -- skipped');
  } else {
    await pool.query(`
      CREATE TABLE form_request_attachments (
        id BIGINT NOT NULL AUTO_INCREMENT,
        form_request_id BIGINT NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(100) NOT NULL,
        size_bytes INT NOT NULL,
        file_data LONGBLOB NOT NULL,
        uploaded_by_user_id BIGINT DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_form_request_attachments (form_request_id),
        CONSTRAINT fk_form_request_attachment FOREIGN KEY (form_request_id) REFERENCES form_requests (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('  created form_request_attachments');
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
