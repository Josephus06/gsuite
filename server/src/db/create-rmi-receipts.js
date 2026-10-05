// One-off migration: the table an RMI's receipts are recorded in (asked 2026-10-05 -- Jumar could
// not receive an RMI, because receiving had never been built).
//
// One row per line per receipt: how much of an RMI line arrived, when, and who took it in. An RMI
// can arrive in parts, so a line can have several rows; rmi_lines.received stays the running total
// the list and the view already read.
//
// WHY A TABLE OF ITS OWN rather than reading rmi_lines.received into the stock ledger. These rows
// ARE stock movements (lib/stockLedger.js reads them: out of Return From, into Return To, on the
// day received). rmi_lines.received also holds the 199 migrated documents' receipts, which are
// already inside the source system's Beginning Balance the ledger is anchored on -- counting them
// again would move that stock twice. Only receipts taken in T1S land here.
//
//   node src/db/create-rmi-receipts.js [--dry-run]
// Droplet and office replicate: run on ONE box (the droplet).
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const CREATE_RMI_RECEIPT_LINES = `
CREATE TABLE rmi_receipt_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    rmi_id BIGINT NOT NULL,
    rmi_line_id BIGINT NOT NULL,
    item_id BIGINT NOT NULL REFERENCES inventories(id),
    qty DECIMAL(14,4) NOT NULL,
    -- The RMI line's own unit, so the ledger converts it exactly as it would the line.
    uom VARCHAR(30),
    date_received DATE NOT NULL,
    received_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_rmi_receipt_lines_rmi (rmi_id),
    INDEX idx_rmi_receipt_lines_item (item_id, date_received),
    CONSTRAINT fk_rmi_receipt_lines_rmi FOREIGN KEY (rmi_id) REFERENCES rmis(id) ON DELETE CASCADE,
    CONSTRAINT fk_rmi_receipt_lines_line FOREIGN KEY (rmi_line_id) REFERENCES rmi_lines(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`DB: ${db}${DRY_RUN ? ' -- DRY RUN' : ''}`);
  const [exists] = await pool.query("SHOW TABLES LIKE 'rmi_receipt_lines'");
  if (exists.length) console.log('  = rmi_receipt_lines already exists, skipping');
  else if (DRY_RUN) console.log('  ~ would create rmi_receipt_lines');
  else { await pool.query(CREATE_RMI_RECEIPT_LINES); console.log('  + created rmi_receipt_lines'); }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
