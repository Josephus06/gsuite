// Estimates: the reference number behind an Order Confirmation, and supporting documents.
//
// Choosing "PO#" or "Conforme" recorded only the KIND of confirmation, never the number
// itself -- so an estimate said a PO existed without saying which one, and the actual
// document lived in somebody's email.
//
// order_confirmation_ref holds the number; estimate_attachments holds scans of it. Files go
// in the database as LONGBLOB, like job-order attachments and HRD files: there is no object
// storage here and Railway wipes the filesystem on redeploy.
//
// Idempotent -- safe to re-run:
//   node src/db/add-estimate-order-confirmation.js
require('dotenv').config();
const pool = require('../db');

const ATTACHMENTS_DDL = `
CREATE TABLE estimate_attachments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    estimate_id BIGINT NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes INT NOT NULL,
    file_data LONGBLOB NOT NULL,
    uploaded_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_estimate_attachments (estimate_id),
    CONSTRAINT fk_estimate_attachment FOREIGN KEY (estimate_id) REFERENCES estimates(id)
)`;

async function hasColumn(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  if (await hasColumn('estimates', 'order_confirmation_ref')) {
    console.log('  estimates.order_confirmation_ref already present -- skipped.');
  } else {
    // Appended, never positioned: ADD COLUMN ... AFTER forces a full table rebuild, which on
    // a live, space-tight database hangs uninterruptibly. See the note in production-railway.
    await pool.query(
      "ALTER TABLE estimates ADD COLUMN order_confirmation_ref VARCHAR(100) NULL, ALGORITHM=INSTANT",
    );
    console.log('  estimates.order_confirmation_ref added.');
  }

  const [[t]] = await pool.query(
    `SELECT COUNT(*) n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'estimate_attachments'`,
  );
  if (t.n) {
    console.log('  estimate_attachments already exists -- skipped.');
  } else {
    await pool.query(ATTACHMENTS_DDL);
    console.log('  estimate_attachments created.');
  }

  const [[c]] = await pool.query('SELECT COUNT(*) n FROM estimate_attachments');
  console.log(`Done. ${c.n} attachment(s) present.`);
  await pool.end();
}

main().catch((err) => { console.error('Estimate order-confirmation setup failed:', err); process.exit(1); });
