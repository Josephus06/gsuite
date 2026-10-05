// The Non-Inventory create/edit screen carries four fields the Inventory one doesn't: Length and
// Width (the item's own dimensions, not the is_length_based / is_width_based pricing flags),
// Conversion Type next to them, and "Can be Received" on the Purchasing / Inventory tab. All
// nullable / default 0, so every existing row and the Inventory / Service forms are unaffected.
const pool = require('../db');

async function colExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}
async function addCol(table, column, ddl) {
  if (await colExists(table, column)) { console.log(`${table}.${column} exists`); return; }
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`Added ${table}.${column}`);
}

(async () => {
  try {
    await addCol('inventories', 'length', 'length DECIMAL(14,4) NULL');
    await addCol('inventories', 'width', 'width DECIMAL(14,4) NULL');
    await addCol('inventories', 'conversion_type', 'conversion_type VARCHAR(20) NULL');
    await addCol('inventories', 'can_be_received', 'can_be_received BOOLEAN NOT NULL DEFAULT FALSE');
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
