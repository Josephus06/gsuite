// Customers > Relationships links another customer from the list (2026-10-19): adds
// customer_relationships.related_customer_id. A Customer Payment from a customer may then be
// applied to the invoices of the customers on its Relationships tab (lib/customerRelations.js).
// The name / address / contact columns stay, filled from the customer picked.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-customer-relationship-link.js --dry-run
//   node src/db/add-customer-relationship-link.js
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY_RUN ? ' -- DRY RUN' : ''}`);
  const [[col]] = await pool.query(
    `SELECT 1 AS ok FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customer_relationships' AND COLUMN_NAME = 'related_customer_id'`);
  if (col) console.log('= customer_relationships.related_customer_id already exists');
  else if (DRY_RUN) console.log('~ would add customer_relationships.related_customer_id');
  else {
    await pool.query(
      'ALTER TABLE customer_relationships ADD COLUMN related_customer_id BIGINT NULL AFTER customer_id, ADD INDEX idx_cr_related (related_customer_id)');
    console.log('+ added customer_relationships.related_customer_id');
  }
  await pool.end();
}

main().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
