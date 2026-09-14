// Splits a department's approver list into the two jobs it had quietly come to mean.
//
// department_ticket_approvers began as one thing: who signs off a TICKET raised by this
// department. The Forms module then read the same list to decide who may NOTE a liquidation or a
// request for payment, on the grounds that those are the same people -- and mostly they are. But
// "mostly" is not a permission model: naming somebody as a ticket approver silently handed them
// authority over the department's expense claims, and there was no way to grant one without the
// other.
//
// Two flags on the row instead, so the list still holds the department's heads and each row says
// what that person actually does:
//
//   can_approve_ticket   signs off tickets raised by this department   (what the table always meant)
//   can_note_form        notes this department's liquidations and payments
//
// BOTH DEFAULT TO 1, and every existing row is set to 1. That is deliberate: today every name on
// this list does both, and a migration that quietly revoked half of it would break ticket routing
// for the nine departments that depend on it. Narrowing a row is a decision somebody makes on the
// Departments screen, not something this script guesses.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-department-approver-roles.js
const pool = require('../db');

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function addFlag(column, after, label) {
  if (await columnExists('department_ticket_approvers', column)) {
    console.log(`  department_ticket_approvers.${column} already exists.`);
    return;
  }
  await pool.query(
    `ALTER TABLE department_ticket_approvers
       ADD COLUMN ${column} TINYINT(1) NOT NULL DEFAULT 1 AFTER ${after}`,
  );
  // Existing rows take the default, but say it explicitly rather than trusting it: an older MySQL
  // adding a column to a populated table is exactly where a silent NULL would come from.
  const [r] = await pool.query(`UPDATE department_ticket_approvers SET ${column} = 1`);
  console.log(`  Added ${column} (${label}) -- ${r.affectedRows} existing row(s) set to yes.`);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  await addFlag('can_approve_ticket', 'user_id', 'signs off this department\'s tickets');
  await addFlag('can_note_form', 'can_approve_ticket', 'notes this department\'s liquidations and payments');

  const [[s]] = await pool.query(
    `SELECT COUNT(*) AS rows_total,
            SUM(can_approve_ticket = 1) AS tickets,
            SUM(can_note_form = 1) AS forms
       FROM department_ticket_approvers`,
  );
  console.log(`\n  ${s.rows_total} approver row(s): ${s.tickets} approve tickets, ${s.forms} note forms.`);

  const [[dept]] = await pool.query(
    `SELECT COUNT(DISTINCT a.department_id) AS n FROM department_ticket_approvers a
       JOIN departments d ON d.id = a.department_id
      WHERE d.is_active = TRUE AND a.can_note_form = 1`,
  );
  const [[tot]] = await pool.query('SELECT COUNT(*) AS n FROM departments WHERE is_active = TRUE');
  console.log(`  ${dept.n} of ${tot.n} active departments have somebody who can note a form.`);
  console.log('\n  Nothing changed for anyone: every existing approver keeps both jobs.');
  console.log('  Untick either box per person on Master Lists > Departments > Edit.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
