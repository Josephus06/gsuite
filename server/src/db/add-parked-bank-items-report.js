// Registers the "Unidentified Bank Items" report and grants it to whoever signs off bank
// reconciliations.
//
// A pages row is not optional here: requirePermission answers a MISSING page row with a 500, not a
// 403, so shipping the route without this makes the report look broken rather than forbidden. See
// the borrowed-permission-scopes note -- this is the same trap.
//
// GRANTED TO THE RECONCILIATION APPROVERS, because they are who the nightly reminder tells. A
// notification pointing at a report the reader cannot open is worse than no notification: it says
// something needs attention and then refuses to show what.
//
// IDEMPOTENT: safe to re-run. Existing grants are left as they are, so a right somebody has since
// removed by hand is not silently restored.
//
//   node src/db/add-parked-bank-items-report.js
require('dotenv').config();
const pool = require('../db');

const ROUTE = '/reports/parked-bank-items';
const NAME = 'Unidentified Bank Items';
const SOURCE = '/accounting/bank-reconciliation';

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`  ${ROUTE} already registered -- skipped.`);
  } else {
    // Sorted next to the other reports rather than at the end of the whole list.
    const [[near]] = await pool.query("SELECT sort_order FROM pages WHERE route = '/reports/general-ledger'");
    const [res] = await pool.query(
      'INSERT INTO pages (route, name, sort_order) VALUES (?, ?, ?)',
      [ROUTE, NAME, near?.sort_order || 0]);
    page = { id: res.insertId };
    console.log(`  ${ROUTE} registered as "${NAME}" (id ${page.id}).`);
  }

  const [[src]] = await pool.query('SELECT id FROM pages WHERE route = ?', [SOURCE]);
  if (!src) throw new Error(`${SOURCE} is not registered, so there is nobody to carry the grant from.`);

  const [granted] = await pool.query(
    `INSERT INTO user_page_permissions (user_id, page_id, can_view)
     SELECT upp.user_id, ?, 1
       FROM user_page_permissions upp
       JOIN users u ON u.id = upp.user_id
      WHERE upp.page_id = ? AND upp.can_approve = 1 AND u.is_active = 1
        AND NOT EXISTS (SELECT 1 FROM user_page_permissions x WHERE x.user_id = upp.user_id AND x.page_id = ?)`,
    [page.id, src.id, page.id]);
  console.log(`  ${granted.affectedRows} reconciliation approver(s) granted view.`);

  const [who] = await pool.query(
    `SELECT u.display_name, u.account_type FROM user_page_permissions upp
       JOIN users u ON u.id = upp.user_id
      WHERE upp.page_id = ? AND upp.can_view = 1 AND u.is_active = 1 ORDER BY u.display_name`,
    [page.id]);
  console.log(`\n  ${who.length} account(s) can open it:`);
  who.forEach((x) => console.log(`    ${x.display_name}  (${x.account_type || '—'})`));

  await pool.end();
}

main().catch(async (err) => { console.error('Failed:', err.message); await pool.end(); process.exit(1); });
