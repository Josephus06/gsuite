// The 4 financial-statement reports recompute every posted transaction's GL impact on each
// request (glImpact.js getPostedGlLines -- deliberately no persisted ledger table, so reports
// can't drift from the per-transaction GL Impact tabs). That design walks each source document
// and fetches its lines by FK, which is fine *if* the FK is indexed.
//
// Two line tables shipped with only a PRIMARY KEY on id and no index on their parent FK, so
// every one of those per-document lookups was a full table scan. Harmless at seed-data volumes;
// crippling after the 2021-2023 migration filled them (72k / 74k rows). Measured on Jan 2023
// alone: 955 sales_invoice_lines lookups = 58.8s, 1084 item_delivery_lines lookups = 30.9s --
// 89 of the window's 112 seconds spent in two missing indexes.
//
// Also indexes the date_created column each header query filters its window on; those scans
// grew with the same migration (the item_deliveries header query alone measured 16.5s).
const pool = require('../db');

const FK_INDEXES = [
  ['sales_invoice_lines', 'sales_invoice_id'],
  ['item_delivery_lines', 'item_delivery_id'],
  ['item_fulfillment_lines', 'item_fulfillment_id'],
  ['item_receipt_lines', 'item_receipt_id'],
];

// Every header table getPostedGlLines scans by date window.
const DATE_INDEXES = [
  'sales_invoices', 'assembly_builds', 'item_deliveries', 'item_fulfillments', 'item_receipts',
  'customer_payments', 'credit_memos', 'customer_refunds', 'vendor_bills', 'delivery_tickets',
  'inventory_adjustments', 'bill_credits', 'journals', 'cheques', 'fund_transfers', 'bank_deposits',
];

async function tableExists(name) {
  const [r] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return r.length > 0;
}
async function columnExists(table, column) {
  const [r] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return r.length > 0;
}
// True when `column` is already the first column of some index -- that's what makes it usable
// for an equality/range lookup, so a composite starting with it counts and we skip.
async function isIndexedFirst(table, column) {
  const [r] = await pool.query('SHOW INDEX FROM ??', [table]);
  return r.some((i) => i.Seq_in_index === 1 && i.Column_name === column);
}

async function ensureIndex(table, column) {
  if (!(await tableExists(table))) { console.log(`  skip ${table}.${column} (no such table)`); return; }
  if (!(await columnExists(table, column))) { console.log(`  skip ${table}.${column} (no such column)`); return; }
  if (await isIndexedFirst(table, column)) { console.log(`  ok   ${table}.${column} (already indexed)`); return; }
  const name = `idx_${table}_${column}`;
  const t0 = Date.now();
  await pool.query(`ALTER TABLE \`${table}\` ADD INDEX \`${name}\` (\`${column}\`)`);
  console.log(`  ADD  ${table}.${column} -> ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

(async () => {
  try {
    console.log('Foreign-key indexes (per-document line lookups):');
    for (const [table, column] of FK_INDEXES) await ensureIndex(table, column);

    console.log('\nDate-window indexes (header scans):');
    for (const table of DATE_INDEXES) await ensureIndex(table, 'date_created');

    console.log('\nDone.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
