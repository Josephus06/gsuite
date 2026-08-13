// The Transfer Order -> Item Fulfillment -> Item Receipt chain links at the LINE level, and
// live expresses that with its own primary keys:
//
//   an Item Fulfillment line names the Transfer Order line it fulfils, and
//   an Item Receipt line names the Item Fulfillment line it receives,
//   both through SysFK_LdgrInvtySL_LdgrInvty.
//
// Headers can be matched on their document numbers (TO-####, IF-####, IR-####), which are
// already stored. Lines have no such number -- nothing on a line is unique except live's key
// -- so it is kept here. Without it the chain can only be rebuilt inside a single run that
// imports all three levels at once, and a resumed or re-run import would silently produce
// fulfilment lines attached to nothing.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-transfer-chain-live-pk.js
const pool = require('../db');
require('dotenv').config();

const TARGETS = [
  ['transfer_order_lines', 'live_pk VARCHAR(64) NULL'],
  ['item_fulfillment_lines', 'live_pk VARCHAR(64) NULL'],
  ['item_receipt_lines', 'live_pk VARCHAR(64) NULL'],
];

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  for (const [table, ddl] of TARGETS) {
    const [[col]] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'live_pk'`,
      [table]
    );
    if (col.n) {
      console.log(`  ${table}.live_pk already exists -- skipped.`);
      continue;
    }
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    // Indexed because every fulfilment/receipt line is resolved through a lookup on it.
    await pool.query(`CREATE INDEX idx_${table}_live_pk ON ${table} (live_pk)`);
    console.log(`  ${table}.live_pk added (indexed).`);
  }

  console.log('\nDone.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
