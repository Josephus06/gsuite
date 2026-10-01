// Vanessa Krystal Jean Garcia has TWO employee records, so neither her login nor her supervisor
// (Nicole Fuentes) sees all of her work:
//   the migrated one  -- first "Vanessa", last "Krystal Jean Garcia" -- carries her history;
//   a later one       -- first "Vanessa Krystal Jean", last "Garcia" -- carries her login
//                        (users.employee_id), her department, and what she has entered since.
// The name was split at a different space, so nothing matched them up.
//
// MERGE into the migrated record (it holds most of the history):
//   1. every column that points at an employee -- discovered from the schema at run time, so it
//      covers this install's tables -- is moved from the later record to the kept one;
//   2. her login moves onto the kept record, which takes the department and the right name split;
//   3. the later record is deactivated.
// UPDATE IGNORE: a row that would collide with a unique key the kept record already fills (the
// same attendance day imported onto both) stays on the deactivated record and is reported, rather
// than failing the merge. One transaction. Every moved row's id goes into a rollback file.
//
//   node src/db/fix-vanessa-duplicate-employee.js           # dry run: what would move
//   node src/db/fix-vanessa-duplicate-employee.js --apply
//   node src/db/fix-vanessa-duplicate-employee.js --rollback=<file>
const fs = require('fs');
const pool = require('../db');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const ROLLBACK = (process.argv.find((a) => a.startsWith('--rollback=')) || '').split('=')[1];
const NAMED = ['prepared_by_id', 'requestor_id', 'requested_by_id', 'received_by_id', 'noted_by_id', 'checked_by_id',
  'released_by_id', 'approved_by_id', 'custodian_id', 'assigned_to_id', 'driver_id', 'account_officer_id', 'artist_id'];

// Columns that hold an employee id: real foreign keys to employees, plus the naming conventions
// this schema uses where no FK was declared. users.employee_id is handled on its own (step 2).
async function employeeColumns() {
  const [fk] = await pool.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'employees'`);
  const [named] = await pool.query(
    `SELECT c.TABLE_NAME t, c.COLUMN_NAME c FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME AND tb.TABLE_TYPE = 'BASE TABLE'
      WHERE c.TABLE_SCHEMA = DATABASE() AND c.DATA_TYPE IN ('int', 'bigint')
        AND (c.COLUMN_NAME LIKE '%employee_id' OR c.COLUMN_NAME LIKE 'sales_rep%' OR c.COLUMN_NAME IN (?))`, [NAMED]);
  const seen = new Set(); const out = [];
  for (const r of [...fk, ...named]) {
    const k = `${r.t}.${r.c}`;
    if (seen.has(k) || k === 'users.employee_id') continue;
    seen.add(k); out.push(r);
  }
  return out;
}

async function hasIdColumn(t) {
  const [[r]] = await pool.query("SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'id'", [t]);
  return Number(r.n) > 0;
}

async function rollback(file) {
  const rb = JSON.parse(fs.readFileSync(file, 'utf8'));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const m of rb.moved) {
      if (m.ids.length) await conn.query('UPDATE ?? SET ?? = ? WHERE id IN (?) AND ?? = ?', [m.t, m.c, rb.drop, m.ids, m.c, rb.keep]);
    }
    await conn.query('UPDATE users SET employee_id = ? WHERE id = ?', [rb.drop, rb.userId]);
    await conn.query('UPDATE employees SET first_name = ?, last_name = ?, department_id = ? WHERE id = ?', [rb.keepBefore.first_name, rb.keepBefore.last_name, rb.keepBefore.department_id, rb.keep]);
    await conn.query('UPDATE employees SET is_active = ? WHERE id = ?', [rb.dropBefore.is_active, rb.drop]);
    await conn.commit();
    console.log('Rolled back.');
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${ROLLBACK ? 'ROLLBACK' : APPLY ? 'APPLYING' : 'DRY RUN'}`);
  if (ROLLBACK) { await rollback(ROLLBACK); return; }

  const [olds] = await pool.query("SELECT * FROM employees WHERE TRIM(first_name) = 'Vanessa' AND TRIM(last_name) = 'Krystal Jean Garcia'");
  const [news] = await pool.query("SELECT * FROM employees WHERE TRIM(first_name) = 'Vanessa Krystal Jean' AND TRIM(last_name) = 'Garcia'");
  if (olds.length !== 1 || news.length !== 1) {
    console.log(`Expected one of each record, found ${olds.length} migrated and ${news.length} later. Nothing done.`);
    return;
  }
  const keep = olds[0]; const drop = news[0];
  const [users] = await pool.query('SELECT id, display_name FROM users WHERE employee_id = ?', [drop.id]);
  const [keepUsers] = await pool.query('SELECT id FROM users WHERE employee_id = ?', [keep.id]);
  if (users.length !== 1 || keepUsers.length) { console.log('Expected her one login on the later record and none on the migrated one. Nothing done.'); return; }
  console.log(`keep #${keep.id} "${keep.first_name}" / "${keep.last_name}"   drop #${drop.id} "${drop.first_name}" / "${drop.last_name}"   login #${users[0].id} ${users[0].display_name}\n`);

  const cols = await employeeColumns();
  const plan = [];
  for (const { t, c } of cols) {
    const [[r]] = await pool.query('SELECT SUM(?? = ?) AS onDrop, SUM(?? = ?) AS onKeep FROM ??', [c, drop.id, c, keep.id, t]);
    if (Number(r.onDrop)) plan.push({ t, c, onDrop: Number(r.onDrop), onKeep: Number(r.onKeep), withId: await hasIdColumn(t) });
  }
  console.log('To move from the later record onto the kept one:');
  for (const p of plan) console.log(`  ${`${p.t}.${p.c}`.padEnd(45)} ${String(p.onDrop).padStart(5)}   (kept record already has ${p.onKeep})`);
  if (!plan.length) console.log('  nothing');
  console.log(`\nThen: login #${users[0].id} -> employee #${keep.id}; #${keep.id} named "Vanessa Krystal Jean" / "Garcia", department ${keep.department_id ?? drop.department_id}; #${drop.id} deactivated.`);
  if (!APPLY) return;

  const rb = { keep: keep.id, drop: drop.id, userId: users[0].id, keepBefore: { first_name: keep.first_name, last_name: keep.last_name, department_id: keep.department_id },
    dropBefore: { is_active: drop.is_active }, moved: [] };
  const conn = await pool.getConnection();
  const left = [];
  try {
    await conn.beginTransaction();
    for (const p of plan) {
      let ids = [];
      if (p.withId) [ids] = await conn.query('SELECT id FROM ?? WHERE ?? = ? FOR UPDATE', [p.t, p.c, drop.id]);
      await conn.query('UPDATE IGNORE ?? SET ?? = ? WHERE ?? = ?', [p.t, p.c, keep.id, p.c, drop.id]);
      const [[r]] = await conn.query('SELECT COUNT(*) n FROM ?? WHERE ?? = ?', [p.t, p.c, drop.id]);
      let movedIds = ids.map((x) => x.id);
      if (Number(r.n) && p.withId) {
        const [stay] = await conn.query('SELECT id FROM ?? WHERE ?? = ?', [p.t, p.c, drop.id]);
        const stayed = new Set(stay.map((x) => x.id));
        movedIds = movedIds.filter((id) => !stayed.has(id));
      }
      rb.moved.push({ t: p.t, c: p.c, ids: movedIds });
      if (Number(r.n)) left.push(`${p.t}.${p.c}: ${r.n} row(s) collided with the kept record's own and stay on #${drop.id}`);
    }
    await conn.query('UPDATE users SET employee_id = ? WHERE id = ? AND employee_id = ?', [keep.id, users[0].id, drop.id]);
    await conn.query("UPDATE employees SET first_name = 'Vanessa Krystal Jean', last_name = 'Garcia', department_id = COALESCE(department_id, ?) WHERE id = ?", [drop.department_id, keep.id]);
    await conn.query('UPDATE employees SET is_active = 0 WHERE id = ?', [drop.id]);
    const file = `rollback/vanessa-employee-merge-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.mkdirSync('rollback', { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rb));
    await conn.commit();
    console.log(`\nMerged. Rollback file: ${file}`);
    left.forEach((l) => console.log(`  left behind -- ${l}`));
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
