// Lets an approver refuse a ticket instead of only ever being able to wave it through.
//
// Until now the two approval gates -- the creator's department approver (ticket_approvers) and
// the General Manager (after a Forward to GM) -- had exactly one button between them: Approve.
// An approver who did not want the work done had no way to say so. The ticket sat "Pending
// approval from X" forever, indistinguishable from one nobody had got round to, and the person
// who raised it was never told. Refusing was a conversation held somewhere else entirely, and
// the ticket queue carried no record that a decision had been taken at all.
//
// THE REASON IS NOT OPTIONAL. A refusal with no reason tells the requester only that they may
// not have the thing, which is the part they already suspected -- what they need is whether to
// fix the request and raise it again, or drop it. So the endpoint rejects an empty reason, and
// the column is sized for a sentence or two rather than a code.
//
// ONE SET OF COLUMNS FOR BOTH GATES. A ticket is declined, not "declined by the department" or
// "declined by the GM" -- whoever's sign-off was outstanding is recorded in declined_by_user_id,
// which is the question anyone actually asks. Splitting it in two would mean every screen and
// every query handling two nearly-identical states forever.
//
// A declined ticket is FINAL: it cannot be approved, assigned, forwarded or moved to another
// status afterwards, and the nightly reminder stops nagging about it. Its conversation stays
// open so the requester can ask why. To pursue it, raise a new ticket -- reopening would erase
// the record that it was refused, which is the thing worth keeping.
//
// IDEMPOTENT: safe to re-run; existing columns are reported and skipped.
//
//   node src/db/add-ticket-decline.js
const pool = require('../db');

async function colExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}

// Appended, never positioned, and INSTANT where the server supports it -- so this cannot take a
// long metadata lock on a table the chat widget polls.
async function addColumn(column, type) {
  if (await colExists('tickets', column)) { console.log(`  tickets.${column} exists -- skipped`); return; }
  const ddl = `ALTER TABLE tickets ADD COLUMN ${column} ${type}`;
  try {
    await pool.query(`${ddl}, ALGORITHM=INSTANT`);
  } catch (err) {
    if (err.errno !== 1064) throw err;
    console.log(`  (this MySQL has no ALGORITHM=INSTANT; adding ${column} the ordinary way)`);
    await pool.query(ddl);
  }
  console.log(`  Added tickets.${column}`);
}

(async () => {
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
    await addColumn('declined_at', 'DATETIME NULL');
    await addColumn('declined_by_user_id', 'BIGINT NULL');
    await addColumn('decline_reason', 'VARCHAR(500) NULL');

    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM tickets WHERE status = 'declined'");
    console.log(`\nTickets already in the declined status: ${n} (expected 0 on a first run).`);
    console.log('Approvers can now refuse a ticket, with a reason, from the ticket page.');
    await pool.end();
  } catch (err) {
    console.error(err);
    await pool.end();
    process.exit(1);
  }
})();
