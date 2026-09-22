// Adds transfer_order_lines.unit_used -- the Stock Unit / Base Unit toggle on a Transfer Order
// line, mirroring the one Inventory Adjustment has had all along.
//
// WHAT IT MEANS. A Transfer Order says what the requesting warehouse wants pulled out of
// Warehouse - Central. A job order needing 24 SQFT of a sticker raises a line for 24 SQFT, but the
// warehouse may not cut 24 square feet off a roll -- it hands over a whole ROLL, because a roll is
// more than enough. Unit Used is how the requestor says which of the two they are asking for, and
// the Unit column then shows that item's own Stock Unit or Base Unit. The quantity is NOT
// converted: the person changes it themselves, since "1" is the point of asking in rolls.
//
// WHY NULLABLE, AND WHY NO BACKFILL. NULL means nobody has chosen -- which is the truth for all
// 65,933 existing lines. The screens resolve a NULL for DISPLAY ONLY (see unit_used_resolved in
// routes/transferOrders.js), and no stored `unit` changes until somebody actively picks. Writing a
// guess into the column instead would be indistinguishable from a real choice afterwards, and the
// guess would be wrong often enough to matter: measured on this database, 18,756 lines hold a
// legacy composite unit ('ROLL-SQFT-738' -- stock code, base code, factor) that matches neither
// unit outright, and 958 hold 'SHT' against an item whose base is PC and which has no stock unit
// at all.
//
// Spelling follows inventory_adjustment_lines.unit_used: 'stock' / 'base'. That column also holds
// 'StockUnit' / 'BaseUnit' on migrated rows, so everything that reads either one folds both
// spellings (unitUsedIsBase). Nothing migrates into this column, but it is read by the same
// helpers, so it keeps the same shape.
//
// Idempotent; safe to re-run and safe against a live database.
const pool = require('../db');

async function columnExists(table, column) {
  const [r] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return r.length > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  if (await columnExists('transfer_order_lines', 'unit_used')) {
    console.log('  transfer_order_lines.unit_used already exists.');
  } else {
    // Appended with no AFTER clause so it is metadata-only on a table of this size.
    try {
      await pool.query('ALTER TABLE transfer_order_lines ADD COLUMN unit_used VARCHAR(20) NULL, ALGORITHM=INSTANT');
      console.log('  + added transfer_order_lines.unit_used (instant)');
    } catch (err) {
      if (err.code !== 'ER_PARSE_ERROR' && err.errno !== 1845 && err.errno !== 1846) throw err;
      await pool.query('ALTER TABLE transfer_order_lines ADD COLUMN unit_used VARCHAR(20) NULL');
      console.log('  + added transfer_order_lines.unit_used');
    }
  }

  // What the screens will show for the lines nobody has touched, so the effect of the fallback is
  // on the record rather than only in a comment. 'base' is only resolved where the stored unit IS
  // the item's base unit; everything else reads as a stock-unit count, which is the same reading
  // stockLedger.js's toBase has always applied to these lines.
  const [[counts]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(bu.id IS NOT NULL AND UPPER(l.unit) IN (UPPER(bu.title), UPPER(bu.code))) AS reads_base,
            SUM(l.unit_used IS NOT NULL) AS chosen
       FROM transfer_order_lines l
       LEFT JOIN inventories i ON i.id = l.item_id
       LEFT JOIN units_of_measure bu ON bu.id = i.base_unit_id`,
  );
  const base = Number(counts.reads_base || 0);
  console.log(`\n  ${counts.total} transfer order line(s): ${counts.chosen} carry an explicit Unit Used.`);
  console.log(`  Of the rest, ${base} will show "Base Unit" and ${counts.total - base - Number(counts.chosen)} "Stock Unit" until someone chooses.`);
  console.log('  No stored Unit changes until a person picks one on the screen.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
