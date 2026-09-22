// One-off migration: registers Accounting > Reports > AP Aging in the `pages` table.
//
// requirePermission resolves a route to a `pages` row before it checks anything, so without this
// row /reports/ap-aging refuses every user including System Admin, and the nav hides the
// link. Admins are granted full access in the same run so the report cannot be left registered
// but unreachable.
//
// It deliberately gets its OWN row rather than borrowing /reports/ar-aging's: a borrowed scope is
// what turns a missing row into a 500 instead of a 403, and receivables and payables are not the
// same job -- plenty of people should see one and not the other.
//
// No schema change and no index: the report reads vendor_bills, bill_payments and bill_credits
// through their existing keys.
//
// Existing AR Aging viewers are seeded as the starting audience, because that is who reads an
// aging report here, and a report nobody can open is the same as no report. Payables is a
// different job from receivables, though -- review the list afterwards and remove anyone who
// should not see what the company owes.
//
// Idempotent -- safe to re-run:
//   node src/db/register-ap-aging-page.js --dry-run   (report only)
//   node src/db/register-ap-aging-page.js             (apply)
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const ROUTE = '/reports/ap-aging';
const NAME = 'AP Aging';
const MODULE = 'Accounting';

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`Page ${ROUTE} already registered (id ${page.id}).`);
  } else if (DRY_RUN) {
    console.log(`Would register ${ROUTE} as "${NAME}".`);
  } else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name'];
    const values = [ROUTE, NAME];
    if (has.has('module')) { fields.push('module'); values.push(MODULE); }
    const [result] = await pool.query(
      `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
      values,
    );
    page = { id: result.insertId };
    console.log(`Registered ${ROUTE} as "${NAME}" (id ${page.id}).`);
  }

  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE",
  );
  if (!page) {
    console.log(`Would grant full access to ${admins.length} admin(s) once the page row exists.`);
    await pool.end();
    return;
  }
  for (const user of admins) {
    const [[existing]] = await pool.query(
      'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id],
    );
    if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get full access.`); continue; }
    if (existing) {
      await pool.query(
        'UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE WHERE id = ?',
        [existing.id],
      );
    } else {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve)
         VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)`,
        [user.id, page.id],
      );
    }
    console.log(`  + ${user.display_name}: full access.`);
  }

  // Everyone who can already open AR Aging gets the detail behind it. Anything else would mean
  // the people whose job this is have to be granted it one by one before the report is usable,
  // and a detail report nobody can open is the same as no report.
  const [[summary]] = await pool.query('SELECT id FROM pages WHERE route = ?', ['/reports/ar-aging']);
  if (!summary) {
    console.log('\n/reports/ar-aging is not registered here, so there are no viewers to copy.');
  } else {
    const [viewers] = await pool.query(
      `SELECT p.user_id, u.display_name
         FROM user_page_permissions p
         JOIN users u ON u.id = p.user_id
        WHERE p.page_id = ? AND p.can_view = TRUE`,
      [summary.id],
    );
    let granted = 0;
    for (const v of viewers) {
      const [[existing]] = await pool.query(
        'SELECT id, can_view FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [v.user_id, page.id],
      );
      if (existing && existing.can_view) continue;
      if (DRY_RUN) { granted += 1; continue; }
      if (existing) {
        await pool.query('UPDATE user_page_permissions SET can_view = TRUE WHERE id = ?', [existing.id]);
      } else {
        await pool.query(
          'INSERT INTO user_page_permissions (user_id, page_id, can_view) VALUES (?, ?, TRUE)',
          [v.user_id, page.id],
        );
      }
      granted += 1;
    }
    console.log(`\n${DRY_RUN ? 'Would copy' : 'Copied'} AR Aging's view permission to ${granted} more user(s) ` +
      `(${viewers.length} can view AR Aging).`);
  }

  await pool.end();
}

main().catch((err) => { console.error('Registration failed:', err); process.exit(1); });
