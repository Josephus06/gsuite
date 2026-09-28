// Opening balances: T1S continues the source system's books. The source's closing position at
// 2025-12-31 is loaded here and T1S's financial reports start from it on 2026-01-01, reading only
// transactions dated from then on. Records before 2026 stay in T1S as history; they no longer
// feed any balance.
//
//   opening_gl_balances   one row per account: the 2025-12-31 balance (debit - credit). Income and
//                         expense are already closed into Retained Earnings by the loader.
//   opening_ar_items      every customer document open at 2025-12-31 -- invoices, credits,
//                         unapplied payments -- so 2026 collections apply to real items and the
//                         aging still ages them.
//   opening_ap_items      the same for suppliers: bills, bill credits, AP journals.
//
// Keyed per document PER PARTY: one journal can be open against several suppliers at once
// (JRNL-4767 on the 2025-12-31 AP), so a document number alone is not unique.
//
// The books start date is not a separate setting: it is the day after MAX(as_of) in
// opening_gl_balances. No rows = no opening = every report behaves exactly as before.
//
// Filled by src/db/load-opening-balances.js. IDEMPOTENT: safe to re-run.
//
//   node src/db/create-opening-balances.js
const pool = require('../db');

async function tableExists(name) {
  const [[r]] = await pool.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name],
  );
  return r.n > 0;
}

async function createTable(name, ddl) {
  if (await tableExists(name)) { console.log(`  Table ${name} already exists.`); return; }
  await pool.query(ddl);
  console.log(`  Created table ${name}.`);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  await createTable('opening_gl_balances', `
    CREATE TABLE opening_gl_balances (
      id BIGINT NOT NULL AUTO_INCREMENT,
      as_of DATE NOT NULL,
      account_id BIGINT NOT NULL,
      account_code VARCHAR(50) NOT NULL,
      debit DECIMAL(18,2) NOT NULL DEFAULT 0,
      credit DECIMAL(18,2) NOT NULL DEFAULT 0,
      note VARCHAR(300) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_opening_gl (as_of, account_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // balance is signed the way the aging reads it: positive = the customer owes us.
  await createTable('opening_ar_items', `
    CREATE TABLE opening_ar_items (
      id BIGINT NOT NULL AUTO_INCREMENT,
      as_of DATE NOT NULL,
      customer_id BIGINT NULL,
      source_customer_pk VARCHAR(64) NULL,
      customer_name VARCHAR(255) NOT NULL,
      doc_type VARCHAR(30) NOT NULL,
      doc_no VARCHAR(60) NOT NULL,
      source_doc_pk VARCHAR(64) NULL,
      doc_date DATE NULL,
      due_date DATE NULL,
      original_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
      balance DECIMAL(18,2) NOT NULL,
      sales_invoice_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_opening_ar_customer (customer_id),
      KEY idx_opening_ar_invoice (sales_invoice_id),
      UNIQUE KEY uq_opening_ar (as_of, doc_type, doc_no, source_customer_pk)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // balance positive = we owe the supplier.
  await createTable('opening_ap_items', `
    CREATE TABLE opening_ap_items (
      id BIGINT NOT NULL AUTO_INCREMENT,
      as_of DATE NOT NULL,
      supplier_id BIGINT NULL,
      source_supplier_pk VARCHAR(64) NULL,
      supplier_name VARCHAR(255) NOT NULL,
      doc_type VARCHAR(30) NOT NULL,
      doc_no VARCHAR(60) NOT NULL,
      source_doc_pk VARCHAR(64) NULL,
      doc_date DATE NULL,
      due_date DATE NULL,
      original_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
      balance DECIMAL(18,2) NOT NULL,
      vendor_bill_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_opening_ap_supplier (supplier_id),
      KEY idx_opening_ap_bill (vendor_bill_id),
      UNIQUE KEY uq_opening_ap (as_of, doc_type, doc_no, source_supplier_pk)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  console.log('\nDone.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
