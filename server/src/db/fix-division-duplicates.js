// The importer's resolveDivision matched by exact name, so live "Sales-3" didn't match the
// app's seeded "Sales - 3" (with spaces) and it CREATED a duplicate division. Migrated orders
// then pointed at the duplicate instead of the canonical division the app/users actually use
// (which breaks the SBU commission rollup and shows the wrong Department).
//
// This consolidates duplicates: divisions whose names are equal once spaces are stripped and
// lowercased are merged into the canonical one (the lowest id -- the app's seed), every
// reference is repointed, the duplicate is deleted, and the survivor is renamed to the
// live/no-space form ("Sales-3").
//
//   node src/db/fix-division-duplicates.js --dry-run
//   node src/db/fix-division-duplicates.js
const pool = require('../db');
require('dotenv').config();
const DRY_RUN = process.argv.includes('--dry-run');
const norm = (s) => (s || '').toString().replace(/\s+/g, '').toLowerCase();

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING.\n');

  const [divs] = await pool.query('SELECT id, name FROM sales_divisions ORDER BY id');
  const groups = new Map();
  for (const d of divs) { const k = norm(d.name); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); }

  for (const [, list] of groups) {
    if (list.length < 2) continue;
    const canonical = list[0];           // lowest id = the app's original
    const dups = list.slice(1);
    const liveName = canonical.name.replace(/\s*-\s*/g, '-').trim(); // "Sales - 3" -> "Sales-3"
    console.log(`Merging ${dups.map((d) => `#${d.id} "${d.name}"`).join(', ')} -> #${canonical.id} (renamed "${liveName}")`);
    for (const dup of dups) {
      for (const [table, col] of [['sales_orders', 'sales_division_id'], ['estimates', 'sales_division_id'],
        ['sales_invoices', 'department_id'], ['customer_payments', 'department_id']]) {
        const [[cnt]] = await pool.query(`SELECT COUNT(*) c FROM ${table} WHERE ${col} = ?`, [dup.id]);
        if (cnt.c) { console.log(`  ${table}.${col}: ${cnt.c} row(s)`); if (!DRY_RUN) await pool.query(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [canonical.id, dup.id]); }
      }
      // user_sales_divisions: repoint, but avoid a duplicate (user already on canonical).
      if (!DRY_RUN) {
        await pool.query('DELETE FROM user_sales_divisions WHERE sales_division_id = ? AND user_id IN (SELECT user_id FROM (SELECT user_id FROM user_sales_divisions WHERE sales_division_id = ?) x)', [dup.id, canonical.id]);
        await pool.query('UPDATE user_sales_divisions SET sales_division_id = ? WHERE sales_division_id = ?', [canonical.id, dup.id]);
        await pool.query('DELETE FROM sales_divisions WHERE id = ?', [dup.id]);
      }
    }
    if (!DRY_RUN && liveName !== canonical.name) await pool.query('UPDATE sales_divisions SET name = ? WHERE id = ?', [liveName, canonical.id]);
  }

  if (DRY_RUN) console.log('\nDRY RUN -- nothing written.');
  else console.log('\nDone.');
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
