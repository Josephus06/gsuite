// Links each Landed Cost to the inventory item a Landed Cost PO line actually records.
//
// THE PROBLEM THIS SOLVES. A Landed Cost PO (PO-2) is for freight, customs, cutting and the like,
// and its Add Item picker offered the WHOLE inventory -- thousands of stock items, none of which
// belongs on a landed cost. The charges themselves already exist as inventory items and the 907
// existing PO-2 lines already use them (FREIGHT/SHIPPING CHARGES is item 6578), so nothing about
// the line needs to change. What was missing was a way to offer only those items.
//
// WHY A STORED LINK AND NOT A NAME MATCH. The obvious shortcut is to match inventories.item_code
// against landed_costs.name, and on today's data that happens to give a clean one-to-one for all
// six. It is still wrong: rename a landed cost -- exactly what a lookup screen is for -- and the
// link silently disappears, taking the charge out of the picker with no error anywhere. Matching
// on display_name instead is worse; it already resolves "PACKING CHARGE" to an item whose code
// reads "DO NOT USE THIS ACCOUNT".
//
// So the link is stored once, here, and maintained on the Landed Costs lookup thereafter.
//
// A LANDED COST WITH NO ITEM IS NOT AN ERROR -- it simply cannot be picked yet, and the screen
// says so rather than hiding it.
//
// Idempotent; safe to re-run and safe against a live database.
const pool = require('../db');

async function columnExists(table, column) {
  const [r] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return r.length > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  if (await columnExists('landed_costs', 'item_id')) {
    console.log('  landed_costs.item_id already exists.');
  } else {
    // Appended with no AFTER clause so it is metadata-only -- same reasoning as add-user-profile.js.
    try {
      await pool.query('ALTER TABLE landed_costs ADD COLUMN item_id BIGINT NULL, ALGORITHM=INSTANT');
      console.log('  + added landed_costs.item_id (instant)');
    } catch (err) {
      if (err.code !== 'ER_PARSE_ERROR' && err.errno !== 1845 && err.errno !== 1846) throw err;
      await pool.query('ALTER TABLE landed_costs ADD COLUMN item_id BIGINT NULL');
      console.log('  + added landed_costs.item_id');
    }
  }

  // Backfill on the EXACT item_code only. Matching display_name as well would link "PACKING
  // CHARGE" to the item coded "DO NOT USE THIS ACCOUNT", and a wrong link is worse than none --
  // it would put that item on a real purchase order.
  const [r] = await pool.query(
    `UPDATE landed_costs lc
       JOIN inventories i ON i.item_code = lc.name
        SET lc.item_id = i.id
      WHERE lc.item_id IS NULL`,
  );
  console.log(`  Linked ${r.affectedRows} landed cost(s) to their inventory item by exact code.`);

  // allocation_method is enum('By Value','By Quantity','By Weight') and every row holds '' -- the
  // placeholder MySQL stores when a value outside the enum is written under a non-strict session.
  // Reading it is harmless; writing it back is not, so editing ANY landed cost on the lookup screen
  // failed with "Data truncated for column 'allocation_method'". NULL is a value the column
  // actually allows, and means the same thing: nothing chosen.
  const [fixed] = await pool.query(
    "UPDATE landed_costs SET allocation_method = NULL WHERE allocation_method = ''");
  if (fixed.affectedRows) {
    console.log(`  Repaired ${fixed.affectedRows} row(s) holding an invalid empty allocation_method.`);
  }

  const [rows] = await pool.query(
    `SELECT lc.name, lc.is_active, i.id AS item_id, i.item_code
       FROM landed_costs lc LEFT JOIN inventories i ON i.id = lc.item_id
      ORDER BY lc.name`,
  );
  console.log('');
  for (const x of rows) {
    console.log(`  ${String(x.name).padEnd(26)}${x.item_id ? `item ${x.item_id}  ${x.item_code}` : 'NOT LINKED -- cannot be picked yet'}`);
  }

  const unlinked = rows.filter((x) => !x.item_id && x.is_active);
  if (unlinked.length) {
    console.log(`\n  ${unlinked.length} active landed cost(s) have no item. Set one on`);
    console.log('  Master Lists > Landed Costs > Edit before they can be used on a PO-2.');
  }

  // Worth knowing: what past PO-2 lines used that the lookup does not cover. Not touched -- history
  // is history -- but it is the list of charges somebody may expect to find and will not.
  const [used] = await pool.query(
    `SELECT DISTINCT i.id, i.item_code
       FROM purchase_order_lines l
       JOIN purchase_orders o ON o.id = l.purchase_order_id AND o.type = 'PO2'
       JOIN inventories i ON i.id = l.item_id
      WHERE i.id NOT IN (SELECT item_id FROM landed_costs WHERE item_id IS NOT NULL)
      ORDER BY i.item_code`,
  );
  if (used.length) {
    console.log(`\n  ${used.length} item(s) used on past landed cost POs are NOT in the lookup:`);
    used.forEach((u) => console.log(`    ${String(u.item_code).padEnd(26)}(item ${u.id})`));
    console.log('  Add them as Landed Costs if they should still be available.');
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
