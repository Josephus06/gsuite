// Adds a real can_print permission alongside can_view / can_add / can_edit / can_delete /
// can_approve, so printing a Job Order can be granted independently of viewing one.
//
// Printing a JO is not the same capability as reading it: the printed sheet is what goes to
// the production floor, so it is granted deliberately. System Admin keeps blanket access --
// admins print any JO at any status -- while every other account needs can_print on
// /job-orders AND a JO that actually has an artist assigned.
//
// IDEMPOTENT: safe to re-run. Both ALTERs are skipped when the column already exists.
//
//   node src/db/add-can-print-permission.js
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
  if (await hasColumn(table, 'can_print')) {
    console.log(`  ${table}.can_print already exists -- skipped.`);
    return;
  }
  await pool.query(`ALTER TABLE ${table} ADD COLUMN can_print BOOLEAN NOT NULL DEFAULT FALSE AFTER can_approve`);
  console.log(`  ${table}.can_print added.`);
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  await addColumn('user_page_permissions');
  await addColumn('account_type_permissions');

  // System Admin prints anything, so grant it everywhere rather than on /job-orders alone --
  // that matches how create-account-type-permissions.js already treats the role.
  const [atp] = await pool.query(
    "UPDATE account_type_permissions SET can_print = TRUE WHERE account_type = 'System Admin'"
  );
  console.log(`  account_type_permissions: ${atp.affectedRows} System Admin row(s) granted can_print.`);

  const [upp] = await pool.query(
    `UPDATE user_page_permissions upp
       JOIN users u ON u.id = upp.user_id
        SET upp.can_print = TRUE
      WHERE u.account_type = 'System Admin'`
  );
  console.log(`  user_page_permissions: ${upp.affectedRows} System Admin row(s) granted can_print.`);

  // Everyone else starts with can_print = FALSE (the column default) and is granted it
  // deliberately from Users & Permissions.
  const [[jo]] = await pool.query("SELECT id FROM pages WHERE route = '/job-orders'");
  if (!jo) {
    console.warn("  !! /job-orders is not registered in `pages` -- the print endpoint will 500 until it is.");
  } else {
    const [[granted]] = await pool.query(
      'SELECT COUNT(*) AS n FROM user_page_permissions WHERE page_id = ? AND can_print = TRUE',
      [jo.id]
    );
    console.log(`\n${granted.n} user(s) can currently print a Job Order.`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
