// READ-ONLY. Why can't a supervisor see a rep's sales transactions? Runs the app's own
// getSalesRepEmployeeScope for the viewer and shows whether the rep is inside it, and which
// supervisor links exist -- so the answer comes from this install's data, not a guess.
//
//   node src/db/check-sales-visibility.js "<viewer name part>" "<rep name part>"
//   node src/db/check-sales-visibility.js "nicole fuentes" "vanessa"
const pool = require('../db');
require('dotenv').config();
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');

async function findUser(part) {
  const [rows] = await pool.query(
    "SELECT id, display_name, account_type, is_account_officer, is_supervisor, employee_id, is_active FROM users WHERE display_name LIKE ?",
    [`%${part.split(/\s+/).join('%')}%`]);
  return rows;
}

async function main() {
  const [viewerPart, repPart] = process.argv.slice(2);
  if (!viewerPart || !repPart) { console.log('Usage: node src/db/check-sales-visibility.js "<viewer>" "<rep>"'); return; }
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);
  const viewers = await findUser(viewerPart); const reps = await findUser(repPart);
  if (viewers.length !== 1 || reps.length !== 1) {
    console.log('Need exactly one match each.', { viewers: viewers.map((u) => u.display_name), reps: reps.map((u) => u.display_name) });
    return;
  }
  const v = viewers[0]; const r = reps[0];
  console.log('viewer:', v); console.log('rep:   ', r);

  const [links] = await pool.query(
    `SELECT us.user_id, u.display_name AS rep, us.supervisor_id, s.display_name AS supervisor
       FROM user_supervisors us JOIN users u ON u.id = us.user_id JOIN users s ON s.id = us.supervisor_id
      WHERE us.user_id = ? OR us.supervisor_id = ?`, [r.id, v.id]);
  console.log('\nsupervisor links touching either:'); links.forEach((l) => console.log(`  ${l.rep} -> ${l.supervisor}`));
  console.log(`  rep listed under viewer: ${links.some((l) => l.user_id === r.id && l.supervisor_id === v.id) ? 'YES' : 'NO'}`);

  const scope = await getSalesRepEmployeeScope(v.id);
  console.log(`\nviewer's scope: ${scope === null ? 'UNRESTRICTED (sees everyone)' : `${scope.length} employee id(s)`}`);
  if (scope) console.log(`  rep's employee #${r.employee_id} in scope: ${scope.includes(r.employee_id) ? 'YES' : 'NO'}`);

  const [[so]] = await pool.query('SELECT COUNT(*) n FROM sales_orders WHERE sales_rep_id = ?', [r.employee_id]);
  console.log(`\nsales orders on the rep's employee #${r.employee_id}: ${so.n}`);
  const [dups] = await pool.query(
    `SELECT e.id, CONCAT(e.first_name, ' / ', e.last_name) nm, e.is_active, (SELECT COUNT(*) FROM sales_orders s WHERE s.sales_rep_id = e.id) sos
       FROM employees e WHERE REPLACE(CONCAT(e.first_name, e.last_name), ' ', '') = (SELECT REPLACE(CONCAT(first_name, last_name), ' ', '') FROM employees WHERE id = ?)`,
    [r.employee_id]);
  console.log('employee records with the rep\'s name:'); dups.forEach((d) => console.log(`  #${d.id} "${d.nm}" active=${d.is_active} sales_orders=${d.sos}`));
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
