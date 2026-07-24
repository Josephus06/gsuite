// One-off migration: creates user_sales_divisions -- the sales divisions a Sales Business
// Unit user owns, for the SBU commission rollup (own + every assigned division's sales).
// No page to register; it's part of the existing Users module.
//
// Idempotent -- safe to re-run:
//   node src/db/create-user-sales-divisions.js --dry-run
//   node src/db/create-user-sales-divisions.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const DDL = `
CREATE TABLE user_sales_divisions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NOT NULL,
    sales_division_id BIGINT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_user_division (user_id, sales_division_id),
    INDEX idx_usd_user (user_id)
)`;

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- nothing will be written.\n' : 'APPLYING changes.\n');

  const [exists] = await pool.query("SHOW TABLES LIKE 'user_sales_divisions'");
  if (exists.length) {
    console.log('Table user_sales_divisions already exists.');
  } else if (DRY_RUN) {
    console.log('Would create table user_sales_divisions.');
  } else {
    await pool.query(DDL);
    console.log('Created table user_sales_divisions.');
  }

  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
