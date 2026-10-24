// Files attached to a Customer Payment or a Sales Invoice -- the customer's BIR 2307 copies above
// all (asked 2026-10-24). One table for both, keyed by (doc_type, doc_id); routes/documentAttachments.js.
//
//   node src/db/create-document-attachments.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS document_attachments (
    id BIGINT NOT NULL AUTO_INCREMENT,
    doc_type VARCHAR(30) NOT NULL,
    doc_id BIGINT NOT NULL,
    kind VARCHAR(40) NOT NULL DEFAULT 'BIR 2307',
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes INT NOT NULL,
    file_data LONGBLOB NOT NULL,
    uploaded_by_user_id BIGINT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_document_attachments_doc (doc_type, doc_id)
  )`);
  console.log('  document_attachments ready');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
