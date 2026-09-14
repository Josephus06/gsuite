// Gives a form the DEPARTMENT IT CAME FROM, as a link rather than a name.
//
// form_requests.department is a NAME, and deliberately so: it is printed on the sheet and must not
// change years later when a department is renamed or somebody moves. Routing an approval needs the
// opposite thing -- a live link to the department row, so "who heads the department this form came
// from" can be answered now rather than as of the day it was filed.
//
// So the form carries both, and they answer different questions:
//   department      what the printed sheet says        frozen
//   department_id   whose head has to note it          live
//
// Matching on the name instead would work today -- every department name on a user's default
// branch matches a departments row exactly -- and break the first time one is renamed, silently,
// by leaving forms with nobody able to note them.
//
// THE HEAD OF A DEPARTMENT, for this purpose, is whoever is listed as its TICKET APPROVER
// (department_ticket_approvers) -- the same people, per the team. Not departments.head_user_id,
// which is a separate field that disagrees with it in the current data; this script reports the
// disagreement rather than picking a winner.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-form-department-id.js
const pool = require('../db');

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  if (await columnExists('form_requests', 'department_id')) {
    console.log('  form_requests.department_id already exists.');
  } else {
    await pool.query('ALTER TABLE form_requests ADD COLUMN department_id BIGINT NULL AFTER department');
    await pool.query('ALTER TABLE form_requests ADD KEY idx_form_requests_department (department_id)');
    console.log('  Added form_requests.department_id.');
  }

  // Align the collation with the rest of the schema before anything tries to JOIN on a name.
  //
  // The form_ tables were created without an explicit COLLATE, so MySQL 8 gave them its own default
  // (utf8mb4_0900_ai_ci) while departments and 148 other tables here are utf8mb4_unicode_ci.
  // Comparing two columns across that boundary is not a slow query, it is an ERROR -- "Illegal mix
  // of collations" -- so the backfill below cannot run until this is fixed, and neither could any
  // future join between a form and the rest of the system.
  const [wrong] = await pool.query(
    `SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name LIKE 'form\\_%'
        AND table_collation <> 'utf8mb4_unicode_ci'`,
  );
  for (const { t } of wrong) {
    // Safe on a populated table too: every column here is ASCII in practice, and CONVERT TO
    // rewrites the table rather than reinterpreting the bytes.
    await pool.query(`ALTER TABLE \`${t}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  }
  console.log(wrong.length
    ? `  Converted ${wrong.length} form_ table(s) to utf8mb4_unicode_ci, matching departments.`
    : '  Collations already match the rest of the schema.');

  // Backfill by name for anything filed before the column existed. Exact match only: a fuzzy match
  // would hand somebody's expense claim to the head of a department it never belonged to, which is
  // worse than leaving it unrouted.
  const [r] = await pool.query(
    `UPDATE form_requests f JOIN departments d ON d.name = f.department
        SET f.department_id = d.id
      WHERE f.department_id IS NULL AND f.department IS NOT NULL`,
  );
  console.log(`  Backfilled ${r.affectedRows} existing form(s) from the department name.`);

  const [[unmatched]] = await pool.query(
    "SELECT COUNT(*) AS n FROM form_requests WHERE department_id IS NULL AND COALESCE(department, '') <> ''");
  if (unmatched.n) {
    console.log(`  ${unmatched.n} form(s) carry a department name matching no department row.`);
  }

  // The rule this column exists to serve only works where an approver is actually recorded.
  const [[cov]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM departments WHERE is_active = TRUE) AS total,
            (SELECT COUNT(DISTINCT a.department_id) FROM department_ticket_approvers a
               JOIN departments d ON d.id = a.department_id WHERE d.is_active = TRUE) AS withApprover`,
  );
  console.log(`\n  ${cov.withApprover} of ${cov.total} active departments have a ticket approver.`);

  const [none] = await pool.query(
    `SELECT d.name FROM departments d WHERE d.is_active = TRUE
        AND NOT EXISTS (SELECT 1 FROM department_ticket_approvers a WHERE a.department_id = d.id)
      ORDER BY d.name`,
  );
  if (none.length) {
    console.log('  WITHOUT ONE, so nobody can NOTE a liquidation or payment filed from them:');
    console.log(`    ${none.map((x) => x.name).join(', ')}`);
    console.log('  Add them under the department\'s ticket approvers. Until then those forms go');
    console.log('  straight from SUBMITTED to APPROVED -- approving never required the noting step.');
  }

  // departments.head_user_id exists and is separately maintained. Where the two disagree, somebody
  // is a "head" in one place and not the other, and only the ticket approver can note a form.
  const [disagree] = await pool.query(
    `SELECT d.name AS dept, hu.display_name AS head
       FROM departments d
       JOIN users hu ON hu.id = d.head_user_id
      WHERE d.is_active = TRUE
        AND NOT EXISTS (SELECT 1 FROM department_ticket_approvers a
                         WHERE a.department_id = d.id AND a.user_id = d.head_user_id)
      ORDER BY d.name`,
  );
  if (disagree.length) {
    console.log(`\n  ${disagree.length} department(s) name a HEAD who is not a ticket approver there.`);
    console.log('  Noting follows the ticket approver, so these people cannot note:');
    disagree.forEach((x) => console.log(`    ${String(x.dept).padEnd(26)} ${x.head}`));
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
