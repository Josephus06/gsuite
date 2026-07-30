// Low-GP approval override: when an estimate is approved, an Admin / General Manager may tick
// individual job lines whose GP rate FAILS the passing threshold to still count them toward
// commission. That decision is stored per estimate job line (is_approved_low_gp) and copied onto the
// sales_order_line when the SO is generated -- the commission report reads it there.
const pool = require('../db');

async function colExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}
async function addFlag(table) {
  if (await colExists(table, 'is_approved_low_gp')) { console.log(`${table}.is_approved_low_gp exists`); return; }
  await pool.query(`ALTER TABLE ${table} ADD COLUMN is_approved_low_gp TINYINT NOT NULL DEFAULT 0`);
  console.log(`Added ${table}.is_approved_low_gp`);
}

(async () => {
  try {
    await addFlag('estimate_job_orders');
    await addFlag('sales_order_lines');
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
