// Adds a can_view_all permission alongside can_view / can_add / can_edit / can_delete /
// can_approve / can_print.
//
// can_view answers "may you open this screen at all"; can_view_all answers "whose records do you
// see once you are in". They are different questions. An artist needs can_view on Archiver > Files
// to reach their own layout archives, but has no business reading everyone else's; a supervisor
// needs the same screen showing the whole department. Until now the only account that saw
// everything was System Admin, which meant the only way to give a supervisor that view was to make
// them an admin -- far more access than the job needs.
//
// Granted deliberately, so it defaults to FALSE for everyone. System Admin gets it everywhere,
// matching how create-account-type-permissions.js and add-can-print-permission.js already treat
// the role.
//
// IDEMPOTENT: safe to re-run. Both ALTERs are skipped when the column already exists.
//
//   node src/db/add-can-view-all-permission.js
const pool = require('../db');

async function hasColumn(table, column) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return row.n > 0;
}

async function addColumn(table) {
  if (await hasColumn(table, 'can_view_all')) {
    console.log(`  ${table}.can_view_all already exists -- skipped.`);
    return;
  }
  // Placed after can_edit so the column order matches the order the permission grid renders in,
  // which is the order anyone reading a row of this table in a client will expect.
  await pool.query(`ALTER TABLE ${table} ADD COLUMN can_view_all BOOLEAN NOT NULL DEFAULT FALSE AFTER can_edit`);
  console.log(`  ${table}.can_view_all added.`);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  await addColumn('user_page_permissions');
  await addColumn('account_type_permissions');

  const [atp] = await pool.query(
    "UPDATE account_type_permissions SET can_view_all = TRUE WHERE account_type = 'System Admin'"
  );
  console.log(`  account_type_permissions: ${atp.affectedRows} System Admin row(s) granted can_view_all.`);

  const [upp] = await pool.query(
    `UPDATE user_page_permissions upp
       JOIN users u ON u.id = upp.user_id
        SET upp.can_view_all = TRUE
      WHERE u.account_type = 'System Admin'`
  );
  console.log(`  user_page_permissions: ${upp.affectedRows} System Admin row(s) granted can_view_all.`);

  // Nobody else changes. A non-admin who could see everything yesterday still can, because the
  // only place this flag is read so far -- Archiver > Files -- already let System Admin through
  // on the strength of the account type. Everyone else keeps exactly the view they had.
  const [[granted]] = await pool.query(
    'SELECT COUNT(DISTINCT user_id) AS n FROM user_page_permissions WHERE can_view_all = TRUE'
  );
  console.log(`\n${granted.n} user(s) now hold can_view_all somewhere.`);
  console.log('Grant it per page from Users & Permissions to widen a screen beyond a person\'s own records.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
