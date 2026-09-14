// Registers the Disbursement Report so it can be granted in Users & Permissions.
//
// Its own row rather than borrowing Cheques' or Bill Payments'. The report lists what was paid to
// whom across BOTH, which is the treasurer's and the auditor's question; being able to read that
// is not the same right as being able to raise a payment, and the two source pages are granted to
// different people.
//
// SEEDED FROM CHEQUES, because a cheque register is the closest thing to this report that already
// exists -- whoever can read the cheques can already see most of what it shows. can_view only:
// there is nothing to add, edit or delete on a report, and granting rights that do nothing makes
// the permission grid harder to read, not easier.
//
// Nobody is granted anything they did not already have; this copies an existing can_view and
// nothing more.
//
// IDEMPOTENT: safe to re-run. Existing rows are left alone rather than overwritten, so a re-run
// cannot undo a grant someone has since adjusted by hand.
//
//   node src/db/add-disbursement-report-page.js
const pool = require('../db');

const ROUTE = '/reports/disbursement';
const SOURCE = '/cheques';

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  const [[source]] = await pool.query('SELECT id FROM pages WHERE route = ?', [SOURCE]);
  if (!source) throw new Error(`${SOURCE} is not registered, so its grants cannot be copied.`);

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`Page ${ROUTE}: already registered (id ${page.id}).`);
  } else {
    const [r] = await pool.query('INSERT INTO pages (route, name) VALUES (?, ?)', [ROUTE, 'Disbursement Report']);
    page = { id: r.insertId };
    console.log(`Page ${ROUTE}: registered (id ${page.id}).`);
  }

  const hasViewAll = await columnExists('user_page_permissions', 'can_view_all');
  const viewAllCol = hasViewAll ? ', can_view_all' : '';
  const viewAllVal = hasViewAll ? ', src.can_view_all' : '';

  const [upp] = await pool.query(
    `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print${viewAllCol})
     SELECT src.user_id, ?, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE${viewAllVal}
       FROM user_page_permissions src
      WHERE src.page_id = ? AND src.can_view = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM (SELECT user_id FROM user_page_permissions WHERE page_id = ?) existing
           WHERE existing.user_id = src.user_id)`,
    [page.id, source.id, page.id],
  );
  console.log(`  user_page_permissions: ${upp.affectedRows} grant(s) carried over from ${SOURCE}.`);

  const [atp] = await pool.query(
    `INSERT INTO account_type_permissions (account_type, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print${viewAllCol}, updated_at)
     SELECT src.account_type, ?, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE${viewAllVal}, NOW()
       FROM account_type_permissions src
      WHERE src.page_id = ? AND src.can_view = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM (SELECT account_type FROM account_type_permissions WHERE page_id = ?) existing
           WHERE existing.account_type = src.account_type)`,
    [page.id, source.id, page.id],
  );
  console.log(`  account_type_permissions: ${atp.affectedRows} template row(s) carried over.`);

  // System Admin is full everywhere by definition, and requirePermission reads the row rather
  // than bypassing for admins, so the row has to exist.
  const cols = ['can_view', 'can_add', 'can_edit', 'can_delete', 'can_approve', 'can_print']
    .concat(hasViewAll ? ['can_view_all'] : []);
  await pool.query(
    `INSERT INTO user_page_permissions (user_id, page_id, ${cols.join(', ')})
     SELECT u.id, ?, ${cols.map(() => 'TRUE').join(', ')} FROM users u
      WHERE u.account_type = 'System Admin'
        AND NOT EXISTS (SELECT 1 FROM (SELECT user_id FROM user_page_permissions WHERE page_id = ?) e
                         WHERE e.user_id = u.id)`,
    [page.id, page.id],
  );
  await pool.query(
    `UPDATE user_page_permissions upp JOIN users u ON u.id = upp.user_id
        SET ${cols.map((c) => `upp.${c} = TRUE`).join(', ')}
      WHERE u.account_type = 'System Admin' AND upp.page_id = ?`, [page.id],
  );
  console.log('  System Admin granted in full.');

  const [[see]] = await pool.query(
    'SELECT COUNT(*) AS n FROM user_page_permissions WHERE page_id = ? AND can_view = TRUE', [page.id]);
  console.log(`\n${see.n} user(s) can open the Disbursement Report.`);
  console.log('It appears under Accounting > Reports, and in Users & Permissions as');
  console.log('"Disbursement Report".');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
