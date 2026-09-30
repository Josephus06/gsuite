// The customer form, laid out as the old system's "Setup Your Customer" screen (2026-09-30). The
// source carries these per customer (get_customers: Birthdate_Cust, Gender_Cust, ContactNo_Cust,
// Type_Cust 'Company'/'Individual', IsChargeToLocation_Cust, IsChargeTo_Cust,
// IsAllow90PercentCommission_Cust, BillToName/Address/ContactNo_Cust) plus the EWT / Final Tax
// ticks, per contact person (address, default bill-to contact, approver, certifier), and a list of
// relationships (name, address, contact no). customers.address and customers.tax_id exist already.
//
// Idempotent -- safe to re-run, and --env picks the install:
//   node src/db/add-customer-form-fields.js
//   node src/db/add-customer-form-fields.js --env=railway
const envName = require('./lib/env')();
const pool = require('../db');

const COLUMNS = {
  customers: [
    ['birthdate', 'ADD COLUMN birthdate DATE NULL'],
    ['gender', 'ADD COLUMN gender VARCHAR(10) NULL'],
    ['contact_no', 'ADD COLUMN contact_no VARCHAR(100) NULL'],
    ['customer_type', 'ADD COLUMN customer_type VARCHAR(20) NULL'],
    ['is_charge_to_location', 'ADD COLUMN is_charge_to_location TINYINT(1) NOT NULL DEFAULT 0'],
    ['is_ewt', 'ADD COLUMN is_ewt TINYINT(1) NOT NULL DEFAULT 0'],
    ['is_final_tax', 'ADD COLUMN is_final_tax TINYINT(1) NOT NULL DEFAULT 0'],
    ['is_charge_to', 'ADD COLUMN is_charge_to TINYINT(1) NOT NULL DEFAULT 0'],
    ['include_90_commission', 'ADD COLUMN include_90_commission TINYINT(1) NOT NULL DEFAULT 0'],
    ['bill_to_name', 'ADD COLUMN bill_to_name VARCHAR(200) NULL'],
    ['bill_to_address', 'ADD COLUMN bill_to_address TEXT NULL'],
    ['bill_to_contact_no', 'ADD COLUMN bill_to_contact_no VARCHAR(100) NULL'],
  ],
  customer_contacts: [
    ['address', 'ADD COLUMN address TEXT NULL'],
    ['is_default_bill_to', 'ADD COLUMN is_default_bill_to TINYINT(1) NOT NULL DEFAULT 0'],
    ['is_approver', 'ADD COLUMN is_approver TINYINT(1) NOT NULL DEFAULT 0'],
    ['is_certifier', 'ADD COLUMN is_certifier TINYINT(1) NOT NULL DEFAULT 0'],
  ],
};

async function main() {
  console.log(`Target DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${envName ? ` (--env=${envName})` : ''}`);
  for (const [table, cols] of Object.entries(COLUMNS)) {
    const [existing] = await pool.query('SHOW COLUMNS FROM ??', [table]);
    const have = new Set(existing.map((c) => c.Field));
    for (const [name, ddl] of cols) {
      if (have.has(name)) { console.log(`${table}.${name} already present.`); continue; }
      await pool.query(`ALTER TABLE ${table} ${ddl}`);
      console.log(`Added ${table}.${name}.`);
    }
  }
  const [[t]] = await pool.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'customer_relationships'");
  if (t.n) console.log('customer_relationships already present.');
  else {
    await pool.query(`
      CREATE TABLE customer_relationships (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        customer_id BIGINT NOT NULL,
        name VARCHAR(200) NOT NULL,
        address TEXT NULL,
        contact_no VARCHAR(100) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NULL,
        KEY idx_customer_relationships_customer (customer_id)
      )`);
    console.log('Created customer_relationships.');
  }
  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
