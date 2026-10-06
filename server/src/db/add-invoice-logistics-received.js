// Adds the date an invoice was received by Logistics (asked 2026-10-06): the invoice view's
// "Received by Logistics" button records it, with who recorded it.
//
//   sales_invoices.logistics_received_date         DATE, the day Logistics took the invoice
//   sales_invoices.logistics_received_by_user_id   who recorded it
//
// Must run BEFORE the code that reads them serves (the invoice view selects the recorder's name).
// Droplet and office replicate: run on ONE box (the droplet).
//
//   node src/db/add-invoice-logistics-received.js [--dry-run]
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const COLUMNS = [
  ['logistics_received_date', 'DATE NULL'],
  ['logistics_received_by_user_id', 'BIGINT NULL'],
];

async function hasColumn(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
  return r.n > 0;
}

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`DB: ${db}${DRY_RUN ? ' -- DRY RUN' : ''}`);
  for (const [name, type] of COLUMNS) {
    if (await hasColumn('sales_invoices', name)) console.log(`  = ${name} already exists`);
    else if (DRY_RUN) console.log(`  ~ would add ${name} ${type}`);
    else { await pool.query(`ALTER TABLE sales_invoices ADD COLUMN ${name} ${type}`); console.log(`  + added ${name}`); }
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
