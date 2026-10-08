// One-off repair: point everything that names a DUPLICATE employee record at the real one.
//
// Asked 2026-10-08: estimates moved from Michelle Riveral to "Vanessa Krystal Jean Garcia" did not
// show on Vanessa's account. There are two records for her -- #69 (active, her login) and #277
// (inactive, no login, a trailing space in the first name) -- and the estimates were given #277.
// What a sales account sees is decided by its OWN employee record (lib/salesVisibility.js), so
// anything on #277 is invisible to her.
//
// Every sales_rep_id / prepared_by_id / approved_by_id / employee_id / ... column that names --from
// is moved to --to, with an audit row per estimate / sales order touched. The duplicate itself is
// left in place (inactive), so nothing that still mentions it by id breaks.
//
//   node src/db/merge-duplicate-employee.js --from 277 --to 69 --dry-run
//   node src/db/merge-duplicate-employee.js --from 277 --to 69
// Droplet, office and SM replicate: run on ONE box (the droplet).
const pool = require('../db');
require('dotenv').config();

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : null; };
const FROM = arg('--from');
const TO = arg('--to');
const DRY_RUN = process.argv.includes('--dry-run');
// Who the audit rows name -- audit_logs.set_by_user_id is NOT NULL. Defaults to user #1, the admin who
// asked for this repair.
const BY = arg('--by') || 1;
const COLUMNS = ['sales_rep_id', 'employee_id', 'prepared_by_id', 'approved_by_id', 'artist_id', 'requestor_id', 'assigned_to_id', 'rma_approved_by_id'];
// Documents whose audit trail should say the rep changed, and the auditable_type each uses.
const AUDITED = { estimates: 'Estimate', sales_orders: 'SalesOrder' };

async function main() {
  if (!FROM || !TO || FROM === TO) throw new Error('Usage: --from <duplicate employee id> --to <real employee id> [--dry-run]');
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  const [emps] = await pool.query(
    `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name, e.is_active,
            (SELECT COUNT(*) FROM users u WHERE u.employee_id = e.id) AS logins
       FROM employees e WHERE e.id IN (?, ?)`, [FROM, TO]);
  const from = emps.find((e) => e.id === FROM);
  const to = emps.find((e) => e.id === TO);
  if (!from || !to) throw new Error('Both employee ids must exist.');
  console.log(`From #${from.id} "${from.name}" (active ${from.is_active}, logins ${from.logins})`);
  console.log(`To   #${to.id} "${to.name}" (active ${to.is_active}, logins ${to.logins})\n`);
  if (!to.is_active) throw new Error('The target record is inactive -- refusing to merge into it.');
  if (from.logins) throw new Error('The duplicate still has a login -- move the login first; it decides what that account sees.');

  const [cols] = await pool.query(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema = DATABASE() AND column_name IN (?) AND table_name <> 'users'`, [COLUMNS]);
  let total = 0;
  for (const row of cols) {
    const t = row.t || row.TABLE_NAME; const c = row.c || row.COLUMN_NAME;
    const [hits] = await pool.query(`SELECT id FROM \`${t}\` WHERE \`${c}\` = ?`, [FROM]);
    if (!hits.length) continue;
    total += hits.length;
    console.log(`${DRY_RUN ? 'Would move' : 'Moving'} ${t}.${c}: ${hits.length} row(s) -- ids ${hits.map((h) => h.id).join(', ')}`);
    if (DRY_RUN) continue;
    await pool.query(`UPDATE \`${t}\` SET \`${c}\` = ? WHERE \`${c}\` = ?`, [TO, FROM]);
    if (AUDITED[t]) {
      for (const h of hits) {
        await pool.query(
          `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
           VALUES (?, ?, 'Updated', ?, ?, ?, ?)`,
          [AUDITED[t], h.id, c, String(FROM), String(TO), BY]);
      }
    }
  }
  console.log(total ? `\n${DRY_RUN ? 'Would move' : 'Moved'} ${total} reference(s).` : '\nNothing references the duplicate.');
  await pool.end();
}
main().catch(async (err) => { console.error('Failed:', err.message); await pool.end(); process.exit(1); });
