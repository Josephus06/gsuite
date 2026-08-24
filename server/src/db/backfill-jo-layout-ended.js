// Gives already-approved Job Orders the layout end date they never got, so the artists who did
// that work appear in the Artist Incentive report.
//
// WHY THESE ROWS EXIST. Submitting a Job Order for Sales Approval never closed the layout timer;
// only the "Done" button did, and that button refuses unless the artist pressed Play first. So an
// artist who worked without running the timer reached "Approved" with layout_ended_at NULL. The
// report requires that column -- it is both the filter and the date the incentive is filed under
// -- so the work earned nothing. Submissions from now on close the timer themselves; this is for
// the orders that went through before that.
//
// WHERE THE DATE COMES FROM. Not invented: audit_logs records the transition to "Approved" with
// its timestamp, and that is used. The layout was necessarily finished at or before Sales accepted
// it, so the approval time is the latest it could have been done and the only evidence there is.
// An order with no such audit entry is REPORTED AND SKIPPED rather than given date_forwarded or
// updated_at as a substitute -- those move for unrelated reasons, and a wrong date puts an
// artist's incentive in the wrong month, which is worse than it being absent and noticed.
//
// THIS CHANGES WHAT PEOPLE ARE PAID. It is a dry run unless you pass --apply, and it prints every
// row it would touch so the dates can be checked against what those artists actually did.
//
//   node src/db/backfill-jo-layout-ended.js               show what would change
//   node src/db/backfill-jo-layout-ended.js --apply       make the change
//   node src/db/backfill-jo-layout-ended.js --as-user=7   attribute the audit entries to user 7
const pool = require('../db');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');

// audit_logs.set_by_user_id is NOT NULL and carries a foreign key to users(id) (fk_audit_user), so
// every entry has to name a real user. The first version of this script wrote NULL there, which
// made --apply die on the very first insert -- inside a transaction on Railway, so the run rolled
// back and wrote nothing rather than half-finishing. Defaults to the lowest-numbered active user,
// the admin account on every install so far; --as-user=<id> names someone else. Resolved against
// the database, not hardcoded, because the ids differ between installs.
const AS_USER = (process.argv.find((arg) => arg.startsWith('--as-user=')) || '').split('=')[1];

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(APPLY ? 'MODE: applying changes\n' : 'MODE: dry run -- nothing will be written (pass --apply)\n');

  const [rows] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.artist_id,
            CONCAT(e.first_name, ' ', e.last_name) AS artist_name,
            COALESCE(NULLIF(jo.layout_qty, 0), 1) AS layout_qty,
            (SELECT MIN(a.set_at) FROM audit_logs a
              WHERE a.auditable_type = 'JobOrder' AND a.auditable_id = jo.id
                AND a.new_value = 'Approved') AS approved_at
       FROM job_orders jo
       LEFT JOIN employees e ON e.id = jo.artist_id
      WHERE jo.sub_status = 'Approved'
        AND jo.artist_id IS NOT NULL
        AND jo.layout_ended_at IS NULL
      ORDER BY jo.id`,
  );

  if (!rows.length) {
    console.log('Nothing to do -- every approved Job Order with an artist already has a layout end.');
    await pool.end();
    return;
  }

  const usable = rows.filter((r) => r.approved_at);
  const skipped = rows.filter((r) => !r.approved_at);

  console.log(`${rows.length} approved Job Order(s) with an artist and no layout end.\n`);
  for (const r of usable) {
    // 7.50 per unit of layout work, the JO_INCENTIVE_AMOUNT in lib/artistIncentive.js. Shown so
    // the effect on each artist is visible before anything is written, not discovered afterwards.
    const amount = (7.5 * Number(r.layout_qty)).toFixed(2);
    console.log(`  ${r.job_order_no.padEnd(16)} ${String(r.artist_name || `employee ${r.artist_id}`).padEnd(24)}`
      + ` -> ${String(r.approved_at).slice(0, 19)}   +${amount}`);
  }
  if (skipped.length) {
    console.log(`\n  ${skipped.length} SKIPPED -- no audited approval to date them by:`);
    for (const r of skipped) console.log(`    ${r.job_order_no} (${r.artist_name || `employee ${r.artist_id}`})`);
    console.log('    These need a date chosen by hand, by someone who knows when the work was done.');
  }

  // Resolved before the dry run returns, not after, so a bad --as-user or a user table with nobody
  // active is reported by the safe pass instead of only surfacing once --apply is writing.
  const [[actor]] = await pool.query(
    AS_USER ? 'SELECT id, username FROM users WHERE id = ?'
      : 'SELECT id, username FROM users WHERE is_active = 1 ORDER BY id LIMIT 1',
    AS_USER ? [AS_USER] : [],
  );
  if (!actor) {
    console.error(AS_USER
      ? `\nNo user with id ${AS_USER}. The audit entries need a real user -- pick an existing id.`
      : '\nNo active user to attribute the audit entries to. Pass --as-user=<id>.');
    await pool.end();
    process.exit(1);
  }
  console.log(`\nAudit entries will be attributed to user ${actor.id} (${actor.username}).`);

  if (!APPLY) {
    console.log(`Dry run. Re-run with --apply to set ${usable.length} layout end date(s).`);
    await pool.end();
    return;
  }

  let done = 0;
  for (const r of usable) {
    // sql_log_bin is left alone: this is ordinary data the office replica should receive.
    await pool.query('UPDATE job_orders SET layout_ended_at = ? WHERE id = ? AND layout_ended_at IS NULL', [r.approved_at, r.id]);
    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('JobOrder', ?, 'Updated', 'layout_ended_at', NULL, ?, ?)`,
      [r.id, `backfilled from the audited approval time (${String(r.approved_at).slice(0, 19)})`, actor.id],
    );
    done += 1;
  }

  // Counted from the table afterwards rather than from the loop, so the number reported is what
  // the database actually holds.
  const [[left]] = await pool.query(
    `SELECT COUNT(*) AS n FROM job_orders
      WHERE sub_status = 'Approved' AND artist_id IS NOT NULL AND layout_ended_at IS NULL`,
  );
  console.log(`\n${done} updated. ${left.n} still without a layout end${left.n ? ' (the skipped ones above)' : ''}.`);
  console.log('Each change is recorded in audit_logs, so it is visible on the Job Order rather than silent.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
