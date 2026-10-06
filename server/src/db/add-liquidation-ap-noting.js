// Liquidations are noted by Accounts Payable, not the department head, and only once every item
// carries the COGS account it is charged to (asked 2026-10-06).
//
//   users.is_accounts_payable          the "Accounts Payable" tick on Users & Permissions -- who may
//                                      assign COGS and note a liquidation
//   form_request_items.cogs_account_id the Chart of Accounts line an item is charged to, set by AP
//
// Idempotent -- safe to re-run, and --env picks the install:
//   node src/db/add-liquidation-ap-noting.js
//   node src/db/add-liquidation-ap-noting.js --env=railway
// Droplet and office replicate: run on ONE box (the droplet).
const envName = require('./lib/env')();
const pool = require('../db');

const CHANGES = [
  ['users', 'is_accounts_payable', 'ADD COLUMN is_accounts_payable TINYINT(1) NOT NULL DEFAULT 0'],
  ['form_request_items', 'cogs_account_id', 'ADD COLUMN cogs_account_id BIGINT NULL AFTER amount'],
];

async function main() {
  console.log(`Target DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${envName ? ` (--env=${envName})` : ''}`);
  for (const [table, column, ddl] of CHANGES) {
    const [existing] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
    if (existing.length) { console.log(`${table}.${column} already present.`); continue; }
    await pool.query(`ALTER TABLE ${table} ${ddl}`);
    console.log(`Added ${table}.${column}.`);
  }
  await pool.end();
}

main().catch(async (err) => { console.error('Failed:', err.message); await pool.end(); process.exit(1); });
