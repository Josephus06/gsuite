// Customer > Billing and Collection (asked 2026-10-21, as on the source system's customer page): who
// to bill and who to collect from at a customer, and how -- one row each: Contact Person, Contact
// number, Email Address, Address, Billing / Collection, Billing Requirements, Releasing Schedule,
// Releasing Location, Payment Method, Other Info. Saved with the customer, like its contacts.
// Idempotent.
//   node src/db/add-customer-billing-collection.js
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[col]] = await pool.query(
    "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'id'");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_billing_contacts (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      customer_id ${col.t} NOT NULL,
      contact_person VARCHAR(255) NULL,
      contact_number VARCHAR(255) NULL,
      email VARCHAR(255) NULL,
      address VARCHAR(500) NULL,
      billing_collection VARCHAR(30) NULL,
      billing_requirements VARCHAR(1000) NULL,
      releasing_schedule VARCHAR(255) NULL,
      releasing_location VARCHAR(255) NULL,
      payment_method VARCHAR(255) NULL,
      other_info VARCHAR(1000) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_cbc_customer (customer_id),
      CONSTRAINT fk_cbc_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  console.log('customer_billing_contacts ready.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
