// Vanessa Krystal Jean Garcia has TWO employee records, so her own login sees none of her work and
// her supervisor (Nicole Fuentes) finds nothing under her name:
//   the migrated one  -- first "Vanessa", last "Krystal Jean Garcia" -- carries every transaction
//                        (sales orders, estimates, job orders, invoices, delivery tickets, CRM);
//   a later one       -- first "Vanessa Krystal Jean", last "Garcia" -- carries only her login
//                        (users.employee_id) and her department.
// The name was split at a different space, so nothing matched them up.
//
// Repair: keep the migrated record (the history is on it), move the login onto it, give it the
// department and the right name split, and deactivate the later one. Three rows; nothing is
// re-pointed. Found by name, not id, because ids differ between installs. Refuses unless exactly
// one of each shape exists and the later record holds no transactions.
//
//   node src/db/fix-vanessa-duplicate-employee.js           # dry run
//   node src/db/fix-vanessa-duplicate-employee.js --apply
const pool = require('../db');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const TX_COLS = [
  ['sales_orders', 'sales_rep_id'], ['estimates', 'sales_rep_id'], ['job_orders', 'sales_rep_id'],
  ['sales_invoices', 'sales_rep_id'], ['delivery_tickets', 'sales_rep_id'],
];

async function txCount(empId) {
  let n = 0;
  for (const [t, c] of TX_COLS) {
    const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM ?? WHERE ?? = ?', [t, c, empId]);
    n += Number(r.n);
  }
  return n;
}

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN'}`);
  const [olds] = await pool.query("SELECT * FROM employees WHERE TRIM(first_name) = 'Vanessa' AND TRIM(last_name) = 'Krystal Jean Garcia'");
  const [news] = await pool.query("SELECT * FROM employees WHERE TRIM(first_name) = 'Vanessa Krystal Jean' AND TRIM(last_name) = 'Garcia'");
  if (olds.length !== 1 || news.length !== 1) {
    console.log(`Expected one of each record, found ${olds.length} migrated and ${news.length} later. Nothing done.`);
    return;
  }
  const keep = olds[0]; const drop = news[0];
  const [users] = await pool.query('SELECT id, display_name FROM users WHERE employee_id = ?', [drop.id]);
  const [keepUsers] = await pool.query('SELECT id FROM users WHERE employee_id = ?', [keep.id]);
  const keepTx = await txCount(keep.id); const dropTx = await txCount(drop.id);
  console.log(`keep #${keep.id} "${keep.first_name} ${keep.last_name}" -- ${keepTx} transactions, dept ${keep.department_id}, users ${keepUsers.length}`);
  console.log(`drop #${drop.id} "${drop.first_name} ${drop.last_name}" -- ${dropTx} transactions, dept ${drop.department_id}, users ${users.map((u) => `#${u.id} ${u.display_name}`).join(', ') || 'none'}`);
  if (dropTx > 0) { console.log('The later record has transactions of its own -- re-pointing needed, not this fix. Nothing done.'); return; }
  if (users.length !== 1 || keepUsers.length) { console.log('Expected her one login on the later record and none on the migrated one. Nothing done.'); return; }

  console.log(`\nWill: users #${users[0].id}.employee_id ${drop.id} -> ${keep.id}; employee #${keep.id} name -> "Vanessa Krystal Jean" / "Garcia", department -> ${keep.department_id ?? drop.department_id}; employee #${drop.id} is_active -> 0`);
  if (!APPLY) return;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE users SET employee_id = ? WHERE id = ? AND employee_id = ?', [keep.id, users[0].id, drop.id]);
    await conn.query(
      "UPDATE employees SET first_name = 'Vanessa Krystal Jean', last_name = 'Garcia', department_id = COALESCE(department_id, ?) WHERE id = ? AND TRIM(last_name) = 'Krystal Jean Garcia'",
      [drop.department_id, keep.id]);
    await conn.query('UPDATE employees SET is_active = 0 WHERE id = ?', [drop.id]);
    await conn.commit();
    console.log('Done. Rollback: ' +
      `UPDATE users SET employee_id = ${drop.id} WHERE id = ${users[0].id}; ` +
      `UPDATE employees SET first_name = 'Vanessa', last_name = 'Krystal Jean Garcia', department_id = ${keep.department_id ?? 'NULL'} WHERE id = ${keep.id}; ` +
      `UPDATE employees SET is_active = ${drop.is_active ? 1 : 0} WHERE id = ${drop.id};`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
