// Registers the Product module (the company-profile flipbook) in `pages`.
//
// requirePermission resolves a route to a page row before it checks anything, so a module
// deployed without this row 403s for everyone, System Admin included -- which is exactly what
// happened to NSTDJO. Admins are granted here in the same run so it cannot land unreachable.
//
// Idempotent -- safe to re-run:
//   node src/db/register-product-page.js
require('dotenv').config();
const pool = require('../db');

const ROUTE = '/product';
const NAME = 'Product';

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`  ${ROUTE} already registered (id ${page.id}).`);
  } else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name'];
    const values = [ROUTE, NAME];
    if (has.has('module')) { fields.push('module'); values.push(NAME); }
    const [result] = await pool.query(
      `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
      values,
    );
    page = { id: result.insertId };
    console.log(`  registered ${ROUTE} as "${NAME}" (id ${page.id}).`);
  }

  // The profile is public-facing marketing material, so every active user gets view access
  // rather than only admins -- a salesperson showing it to a customer should not need a
  // permission grant first.
  const [users] = await pool.query('SELECT id FROM users WHERE is_active = TRUE');
  let granted = 0;
  for (const u of users) {
    const [[existing]] = await pool.query(
      'SELECT id, can_view FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [u.id, page.id],
    );
    if (existing) {
      if (!existing.can_view) { await pool.query('UPDATE user_page_permissions SET can_view = TRUE WHERE id = ?', [existing.id]); granted += 1; }
    } else {
      await pool.query(
        'INSERT INTO user_page_permissions (user_id, page_id, can_view) VALUES (?, ?, TRUE)', [u.id, page.id],
      );
      granted += 1;
    }
  }
  console.log(`Done. View access granted to ${granted} of ${users.length} active user(s).`);
  await pool.end();
}

main().catch((err) => { console.error('Product page registration failed:', err); process.exit(1); });
