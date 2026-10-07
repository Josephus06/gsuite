// Adds 'partially_billed' to sales_orders.status (asked 2026-10-07): an order with a billing document
// -- a DT, SI or DR -- that does not yet cover every line reads Partially Billed, and Billed only once
// it all is (SO-70419: 1 of 12 lines invoiced read Billed). lib/salesOrderStatus.js only starts writing
// the new value once this has run -- it checks the column first -- so code and schema can deploy in
// either order.
//
// Idempotent -- safe to re-run, and --env picks the install:
//   node src/db/add-so-partially-billed-status.js
//   node src/db/add-so-partially-billed-status.js --env=railway
// Droplet and office replicate: run on ONE box (the droplet).
const envName = require('./lib/env')();
const pool = require('../db');

const VALUES = ['pending_for_jo', 'jo_in_process', 'pending_delivery', 'partially_delivered', 'pending_billing',
  'pending_billing_partially_delivered', 'partially_billed', 'billed', 'cancelled'];

async function main() {
  console.log(`Target DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${envName ? ` (--env=${envName})` : ''}`);
  const [[col]] = await pool.query("SHOW COLUMNS FROM sales_orders LIKE 'status'");
  if (String(col.Type).includes("'partially_billed'")) { console.log('partially_billed already present.'); await pool.end(); return; }
  // Every value the column has now, kept -- only partially_billed is added.
  const have = String(col.Type).replace(/^enum\(|\)$/g, '').split(',').map((v) => v.replace(/^'|'$/g, ''));
  const missing = have.filter((v) => !VALUES.includes(v));
  const all = [...VALUES, ...missing];
  await pool.query(`ALTER TABLE sales_orders MODIFY COLUMN status ENUM(${all.map((v) => `'${v}'`).join(',')}) ${col.Null === 'NO' ? 'NOT NULL' : 'NULL'} DEFAULT '${col.Default || 'pending_for_jo'}'`);
  console.log('Added partially_billed to sales_orders.status.');
  await pool.end();
}

main().catch(async (err) => { console.error('Failed:', err.message); await pool.end(); process.exit(1); });
