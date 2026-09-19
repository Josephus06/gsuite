// Splits "may edit this record" from "may move this transaction along".
//
// THE NAMES WERE ALREADY LYING. The permission grid has labelled `can_edit` as "Can Update"
// since it was built, so an admin ticking "Can Update" on Job Orders believed they were letting
// someone advance a job order and was in fact handing them the Edit form -- the right to rewrite
// the description, the dates, the materials and the artist. One checkbox, two meanings, and the
// wrong one was the dangerous one.
//
// After this:
//
//   can_edit    the EDIT BUTTON. Structural change to the record itself.
//   can_update  moving the transaction ALONG its own workflow, without touching its content.
//               On a Job Order that is the Sales Approval hand-off; the same split applies
//               wherever a document has a "do the next step" action distinct from editing it.
//
// The case that prompted it: an artist finishes a layout and sends it for Sales Approval. They
// need to advance that job order and must NOT be able to edit it. Until now the only permission
// that expressed "advance it" was can_edit, so the choice was give them the Edit form or make
// the assignment special-cased in code.
//
// SEEDED FROM can_edit, DELIBERATELY. Every existing holder of can_edit gets can_update, so the
// day this deploys nobody can do less than they could the day before. The split only becomes
// visible when an admin REMOVES can_edit from someone and leaves can_update -- which is the new
// capability, and it is opt-in per user.
//
// It does mean can_update is over-granted at first: everyone who could edit can now also update,
// which they could anyway. Tightening that is an admin decision per page, not something a
// migration should guess.
//
// IDEMPOTENT: safe to re-run. The column is added once and the seed only fills rows where
// can_update is still 0 while can_edit is 1, so a re-run cannot undo a grant somebody has since
// switched off by hand.
//
//   node src/db/add-can-update-permission.js
const pool = require('../db');

const TABLES = ['user_page_permissions', 'account_type_permissions'];

async function colExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}

async function addColumn(table) {
  if (await colExists(table, 'can_update')) {
    console.log(`  ${table}.can_update exists -- skipped`);
    return;
  }
  // Positioned after can_edit so the grid's column order matches the order the two are read in;
  // NOT NULL DEFAULT 0 so every existing row has a definite answer rather than a NULL that each
  // call site would have to decide how to read.
  const ddl = `ALTER TABLE ${table} ADD COLUMN can_update TINYINT(1) NOT NULL DEFAULT 0 AFTER can_edit`;
  try {
    await pool.query(`${ddl}, ALGORITHM=INSTANT`);
  } catch (err) {
    if (err.errno !== 1064) throw err;
    console.log(`  (this MySQL has no ALGORITHM=INSTANT; adding ${table}.can_update the ordinary way)`);
    await pool.query(ddl);
  }
  console.log(`  Added ${table}.can_update`);
}

(async () => {
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
    for (const t of TABLES) await addColumn(t);

    console.log('\nSeeding can_update from can_edit so nobody loses an ability today:');
    for (const t of TABLES) {
      const [r] = await pool.query(
        `UPDATE ${t} SET can_update = TRUE WHERE can_edit = TRUE AND can_update = FALSE`
      );
      console.log(`  ${t}: ${r.affectedRows} row(s) carried over`);
    }

    // System Admin is full access by definition, and requirePermission reads the actual row
    // rather than bypassing -- so it has to be granted explicitly, like every other page right.
    const [admin] = await pool.query(
      `UPDATE user_page_permissions upp JOIN users u ON u.id = upp.user_id
          SET upp.can_update = TRUE
        WHERE u.account_type = 'System Admin' AND upp.can_update = FALSE`
    );
    console.log(`  System Admin: ${admin.affectedRows} row(s) granted`);

    const [[stats]] = await pool.query(
      `SELECT SUM(can_edit = TRUE) AS editors, SUM(can_update = TRUE) AS updaters
         FROM user_page_permissions`
    );
    console.log(`\n${stats.editors} grants of can_edit, ${stats.updaters} of can_update -- equal for now,`);
    console.log('by design. The split appears the first time an admin takes can_edit away and');
    console.log('leaves can_update, which is the whole point: advance it, do not rewrite it.');
    await pool.end();
  } catch (err) {
    console.error(err);
    await pool.end();
    process.exit(1);
  }
})();
