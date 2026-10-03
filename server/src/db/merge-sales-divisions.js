// Merge duplicate sales divisions: "Sales - 2" -> "Sales-2" and "Sales - 4" -> "Sales-4" (asked
// 2026-10-03: keep the spelling with no spaces, delete the other). Each pair is the same team typed
// two ways, so its orders were split across two "groups" in reports and filters.
//
// What moves: every column that holds a SALES DIVISION id -- estimates, sales_orders,
// non_standard_sales_orders, customers, web_products and user_sales_divisions (who owns the group,
// which is what SBU scopes and commission read). NOT non_standard_job_orders.sales_division_id:
// despite its name it holds a DEPARTMENT id (see lib/sbuGroups.js), and department 5 is "Sales - 1".
//
// Matched by NAME, not id, because ids differ between installs. Refuses unless each pair resolves to
// exactly one row on each side. Writes a rollback file of every row it moves before changing anything.
// Droplet and office replicate: run on ONE of them.
//
//   node src/db/merge-sales-divisions.js --dry-run
//   node src/db/merge-sales-divisions.js
//   node src/db/merge-sales-divisions.js --rollback=/root/sales-divisions-before-merge-<stamp>.json
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const ROLLBACK = (process.argv.find((a) => a.startsWith('--rollback=')) || '').split('=')[1];
const PAIRS = [['Sales - 2', 'Sales-2'], ['Sales - 4', 'Sales-4']]; // [delete, keep]
const TABLES = ['estimates', 'sales_orders', 'non_standard_sales_orders', 'customers', 'web_products'];

async function hasColumn(table, column) {
  const [r] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return r.length > 0;
}

async function rollback(file) {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const d of saved.divisions) {
      await conn.query('INSERT IGNORE INTO sales_divisions SET ?', [d]);
    }
    for (const [table, rows] of Object.entries(saved.moved)) {
      for (const r of rows) await conn.query('UPDATE ?? SET sales_division_id = ? WHERE id = ?', [table, r.from, r.id]);
    }
    for (const u of saved.owners) {
      await conn.query('INSERT IGNORE INTO user_sales_divisions (user_id, sales_division_id) VALUES (?, ?)', [u.user_id, u.sales_division_id]);
    }
    await conn.commit();
    console.log('Rolled back.');
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

(async () => {
  console.log(`${DRY ? 'DRY RUN -- ' : ''}DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  if (ROLLBACK) { await rollback(ROLLBACK); await pool.end(); return; }

  const plan = [];
  for (const [dropName, keepName] of PAIRS) {
    const [drop] = await pool.query('SELECT * FROM sales_divisions WHERE name = ?', [dropName]);
    const [keep] = await pool.query('SELECT * FROM sales_divisions WHERE name = ?', [keepName]);
    if (drop.length === 0) { console.log(`"${dropName}": not here, nothing to merge.`); continue; }
    if (drop.length !== 1 || keep.length !== 1) throw new Error(`"${dropName}" -> "${keepName}" must be one row each (found ${drop.length} / ${keep.length}).`);
    plan.push({ drop: drop[0], keep: keep[0] });
  }
  if (!plan.length) { await pool.end(); return; }

  const tables = [];
  for (const t of TABLES) if (await hasColumn(t, 'sales_division_id')) tables.push(t);

  const saved = { divisions: plan.map((p) => p.drop), moved: {}, owners: [] };
  for (const { drop, keep } of plan) {
    console.log(`\n"${drop.name}" (id ${drop.id}) -> "${keep.name}" (id ${keep.id})`);
    for (const t of tables) {
      const [rows] = await pool.query('SELECT id FROM ?? WHERE sales_division_id = ?', [t, drop.id]);
      console.log(`  ${t}: ${rows.length}`);
      (saved.moved[t] = saved.moved[t] || []).push(...rows.map((r) => ({ id: r.id, from: drop.id })));
    }
    const [owners] = await pool.query('SELECT user_id, sales_division_id FROM user_sales_divisions WHERE sales_division_id = ?', [drop.id]);
    console.log(`  user_sales_divisions (group owners): ${owners.length}`);
    saved.owners.push(...owners);
  }
  if (DRY) { await pool.end(); return; }

  const file = `${process.platform === 'win32' ? '' : '/root/'}sales-divisions-before-merge-${Date.now()}.json`;
  fs.writeFileSync(file, JSON.stringify(saved));
  console.log(`\nRollback file: ${file}`);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const { drop, keep } of plan) {
      for (const t of tables) await conn.query('UPDATE ?? SET sales_division_id = ? WHERE sales_division_id = ?', [t, keep.id, drop.id]);
      // An owner of both keeps one row; the rest move across.
      await conn.query(
        `INSERT IGNORE INTO user_sales_divisions (user_id, sales_division_id)
         SELECT user_id, ? FROM user_sales_divisions WHERE sales_division_id = ?`, [keep.id, drop.id]);
      await conn.query('DELETE FROM user_sales_divisions WHERE sales_division_id = ?', [drop.id]);
      await conn.query('DELETE FROM sales_divisions WHERE id = ?', [drop.id]);
      console.log(`Merged "${drop.name}" into "${keep.name}" and deleted it.`);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
