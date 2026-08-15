// Adds the "For CSA Assignment" stage to the estimate lifecycle.
//
// An estimate raised on the customer-facing quote site has no sales rep -- nobody took the
// enquiry. It cannot go straight to Pending Customer Approval, because there would be no one to
// send it to or follow it up. So it lands in a new first stage, For CSA Assignment, where the
// Marketing Manager picks the rep who will own it; assigning is what moves it on to Pending
// Customer Approval.
//
// estimates.status is an ENUM, so the value has to be declared before anything can be stored in
// it -- writing an undeclared value fails outright (or, with strict mode off, silently stores an
// empty string). Extending the ENUM is additive: every existing value keeps its place, so the
// 69,245 estimates already here are untouched.
//
// Who may assign is a permission, not a hard-coded job title. /estimates-csa-assignment is
// registered as its own page so `can_approve` on it can be granted to the Marketing Manager
// account alone, without also handing them approval rights over every other estimate.
//
// Idempotent -- safe to re-run:
//   node src/db/add-estimate-csa-assignment.js
const pool = require('../db');
require('dotenv').config();

const STATUS = 'for_csa_assignment';
const ROUTE = '/estimates-csa-assignment';
const NAME = 'Estimates - CSA Assignment';

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  // --- 1. the status ---------------------------------------------------------------------
  const [[col]] = await pool.query(
    `SELECT COLUMN_TYPE AS ct FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'estimates' AND COLUMN_NAME = 'status'`,
    [process.env.DB_NAME]
  );
  if (!col) throw new Error('estimates.status not found');
  if (col.ct.includes(STATUS)) {
    console.log(`estimates.status already offers '${STATUS}'.`);
  } else {
    // Rebuild the ENUM with the new value FIRST -- it is the earliest stage, and MySQL orders
    // an ENUM by declaration, which is what ORDER BY status would sort on.
    const existing = col.ct.replace(/^enum\(/i, '').replace(/\)$/, '');
    await pool.query(`ALTER TABLE estimates MODIFY status ENUM('${STATUS}', ${existing}) NOT NULL`);
    console.log(`estimates.status now offers '${STATUS}'.`);
  }

  // Who assigned the rep, and when -- so the handover is auditable rather than just a status flip.
  for (const [name, ddl] of [
    ['csa_assigned_by_user_id', 'BIGINT NULL'],
    ['csa_assigned_at', 'DATETIME NULL'],
    // Set on estimates that came from the website, so they can be told from ones raised in-house.
    ['web_source', 'VARCHAR(20) NULL'],
  ]) {
    const [has] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.columns
        WHERE table_schema = ? AND table_name = 'estimates' AND COLUMN_NAME = ?`,
      [process.env.DB_NAME, name]
    );
    if (has.length) { console.log(`estimates.${name} already present.`); continue; }
    await pool.query(`ALTER TABLE estimates ADD COLUMN ${name} ${ddl}`);
    console.log(`estimates.${name} added.`);
  }

  // --- 2. the permission -----------------------------------------------------------------
  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`Page ${ROUTE} already registered (id ${page.id}).`);
  } else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name'];
    const values = [ROUTE, NAME];
    if (has.has('module')) { fields.push('module'); values.push('Sales'); }
    if (has.has('sort_order')) {
      const [[sib]] = await pool.query("SELECT sort_order FROM pages WHERE route = '/estimates'");
      fields.push('sort_order');
      values.push(sib?.sort_order != null ? Number(sib.sort_order) + 1 : 0);
    }
    const [result] = await pool.query(
      `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values
    );
    page = { id: result.insertId };
    console.log(`Registered ${ROUTE} as "${NAME}" (id ${page.id}).`);
  }

  // System Admins get it outright. Nobody else does -- assigning is deliberately a granted
  // permission, so the Marketing Manager account is ticked by hand rather than everyone who can
  // already see estimates inheriting the power to hand work out.
  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE"
  );
  for (const user of admins) {
    const [[existing]] = await pool.query(
      'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id]
    );
    if (existing) {
      await pool.query(
        'UPDATE user_page_permissions SET can_view=TRUE, can_approve=TRUE, can_edit=TRUE WHERE id = ?',
        [existing.id]
      );
    } else {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print)
         VALUES (?, ?, TRUE, FALSE, TRUE, FALSE, TRUE, FALSE)`, [user.id, page.id]
      );
    }
    console.log(`  + ${user.display_name}: can assign.`);
  }

  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM estimates WHERE status = ?', [STATUS]);
  console.log(`\nEstimates awaiting CSA assignment: ${n.n}`);
  console.log('Grant can_approve on this page to the Marketing Manager account to let them assign.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
