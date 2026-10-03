// Merge a duplicate DEPARTMENT into the one being kept, then delete it (asked 2026-10-03:
// "Production - SIGN" into "Production-SIGNAGE" -- the same Signage production team typed two ways).
//
// What moves: every column in the database that holds a department id -- found at run time, so a
// table added later is not missed: each *department_id / *dept_id column, plus
// non_standard_job_orders.sales_division_id (despite its name it holds a department id, see
// lib/sbuGroups.js) -- and hr_violations.department_name, which stores the name as text.
// The source-actuals tables (source_dept_*, budget_rows) already use the kept name and are untouched.
//
// Matched by NAME (ids differ between installs). Refuses unless each side is exactly one row and the
// two carry the same Job Location Restriction, so nobody's job order visibility shifts. Writes a
// rollback file of every row it moves first.
// Droplet and office replicate: run on ONE of them.
//
//   node src/db/merge-departments.js --dry-run
//   node src/db/merge-departments.js
//   node src/db/merge-departments.js --rollback=/root/departments-before-merge-<stamp>.json
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const ROLLBACK = (process.argv.find((a) => a.startsWith('--rollback=')) || '').split('=')[1];
const PAIRS = [['Production - SIGN', 'Production-SIGNAGE']]; // [delete, keep]
const NAME_COLUMNS = [['hr_violations', 'department_name']];

async function idColumns() {
  const [rows] = await pool.query(
    `SELECT c.table_name AS t, c.column_name AS c
       FROM information_schema.columns c
       JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
      WHERE c.table_schema = DATABASE() AND (c.column_name LIKE '%department\\_id' OR c.column_name LIKE '%dept\\_id')`);
  const cols = rows.map((r) => [r.t || r.TABLE_NAME, r.c || r.COLUMN_NAME]);
  const [ns] = await pool.query("SHOW COLUMNS FROM non_standard_job_orders LIKE 'sales_division_id'");
  if (ns.length) cols.push(['non_standard_job_orders', 'sales_division_id']);
  return cols;
}

async function rollback(file) {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const d of saved.departments) await conn.query('INSERT IGNORE INTO departments SET ?', [d]);
    for (const m of saved.moved) {
      if (m.name) await conn.query('UPDATE ?? SET ?? = ? WHERE id = ?', [m.table, m.column, m.from, m.id]);
      else await conn.query('UPDATE ?? SET ?? = ? WHERE id = ?', [m.table, m.column, m.from, m.id]);
    }
    await conn.commit();
    console.log(`Rolled back ${saved.moved.length} rows.`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

(async () => {
  console.log(`${DRY ? 'DRY RUN -- ' : ''}DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  if (ROLLBACK) { await rollback(ROLLBACK); await pool.end(); return; }

  const plan = [];
  for (const [dropName, keepName] of PAIRS) {
    const [drop] = await pool.query('SELECT * FROM departments WHERE name = ?', [dropName]);
    const [keep] = await pool.query('SELECT * FROM departments WHERE name = ?', [keepName]);
    if (!drop.length) { console.log(`"${dropName}": not here, nothing to merge.`); continue; }
    if (drop.length !== 1 || keep.length !== 1) throw new Error(`"${dropName}" -> "${keepName}" must be one row each (found ${drop.length} / ${keep.length}).`);
    if (String(drop[0].job_location_id || '') !== String(keep[0].job_location_id || '')) {
      throw new Error(`"${dropName}" and "${keepName}" have different Job Location Restrictions; merging would change what its users can see.`);
    }
    plan.push({ drop: drop[0], keep: keep[0] });
  }
  if (!plan.length) { await pool.end(); return; }

  const cols = await idColumns();
  const saved = { departments: plan.map((p) => p.drop), moved: [] };
  for (const { drop, keep } of plan) {
    console.log(`\n"${drop.name}" (id ${drop.id}) -> "${keep.name}" (id ${keep.id})`);
    for (const [t, c] of cols) {
      const [rows] = await pool.query('SELECT id FROM ?? WHERE ?? = ?', [t, c, drop.id]).catch(() => [[]]);
      if (rows.length) console.log(`  ${t}.${c}: ${rows.length}`);
      saved.moved.push(...rows.map((r) => ({ table: t, column: c, id: r.id, from: drop.id })));
    }
    for (const [t, c] of NAME_COLUMNS) {
      const [rows] = await pool.query('SELECT id FROM ?? WHERE ?? = ?', [t, c, drop.name]).catch(() => [[]]);
      if (rows.length) console.log(`  ${t}.${c} (by name): ${rows.length}`);
      saved.moved.push(...rows.map((r) => ({ table: t, column: c, id: r.id, from: drop.name, name: true })));
    }
  }
  if (DRY) { await pool.end(); return; }

  const file = `${process.platform === 'win32' ? '' : '/root/'}departments-before-merge-${Date.now()}.json`;
  fs.writeFileSync(file, JSON.stringify(saved));
  console.log(`\nRollback file: ${file}`);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const { drop, keep } of plan) {
      for (const [t, c] of cols) {
        const [r] = await conn.query('UPDATE ?? SET ?? = ? WHERE ?? = ?', [t, c, keep.id, c, drop.id]).catch((e) => { throw new Error(`${t}.${c}: ${e.message}`); });
        if (r.affectedRows) console.log(`  moved ${r.affectedRows} in ${t}.${c}`);
      }
      for (const [t, c] of NAME_COLUMNS) await conn.query('UPDATE ?? SET ?? = ? WHERE ?? = ?', [t, c, keep.name, c, drop.name]);
      await conn.query('DELETE FROM departments WHERE id = ?', [drop.id]);
      console.log(`Merged "${drop.name}" into "${keep.name}" and deleted it.`);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
