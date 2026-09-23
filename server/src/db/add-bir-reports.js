// Registers the BIR Reports module -- Sales Report and Purchase Report -- and adds the two
// customer fields the Sales Report needs.
//
// These mirror the live system's "BIR Reports" menu (app.bir-reports = app.sales-report +
// app.purchase-report), which is what the BIR filings are prepared from. The live pages are
// permissioned as "Sales Report" and "Purchase Report", and they are named the same here so the
// permission grid reads the same to the people who already use it.
//
// TWO NEW COLUMNS ON customers, both nullable:
//
//   address   The live Sales Report prints the customer's registered address. suppliers.address
//             already exists and the purchase side reads it; customers never got the equivalent.
//             customer_addresses exists as a table but holds 0 rows, so the report COALESCEs the
//             two -- whichever is filled first starts working with no further change.
//   tax_id    The live report's "Customer Tax Code" column (VAT_PH:VATIN-12 and the like).
//             Points at the existing `taxes` master list rather than a free-text code, so the
//             report cannot print a code that is not a real tax.
//
// BOTH START EMPTY. The Sales Report's other seven columns work immediately; Tax Code and
// Address stay blank on every row until the data is filled in -- by hand on the Customer screen,
// or by a backfill from the live site. That is a data gap, not a broken report, and it is better
// than a report whose columns do not match what the BIR filing expects.
//
// The Purchase Report needs no schema change: vendor_bills already carries net_of_tax,
// tax_amount, gross_amount, wtax_amount and amount_due, and suppliers already has tin and
// address (839 and 1,401 of 1,735 filled on production).
//
// Idempotent -- safe to re-run:
//   node src/db/add-bir-reports.js --dry-run
//   node src/db/add-bir-reports.js
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

const PAGES = [
  { route: '/reports/bir-sales', name: 'Sales Report' },
  { route: '/reports/bir-purchase', name: 'Purchase Report' },
];
const MODULE = 'BIR Reports';

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ? AND COLUMN_NAME = ?`,
    [process.env.DB_NAME, table, column],
  );
  return rows.length > 0;
}

async function addCustomerColumns() {
  if (await columnExists('customers', 'address')) {
    console.log('customers.address already present.');
  } else if (DRY_RUN) {
    console.log('Would add customers.address.');
  } else {
    await pool.query('ALTER TABLE customers ADD COLUMN address TEXT NULL');
    console.log('Added customers.address.');
  }

  if (await columnExists('customers', 'tax_id')) {
    console.log('customers.tax_id already present.');
  } else if (DRY_RUN) {
    console.log('Would add customers.tax_id.');
  } else {
    await pool.query('ALTER TABLE customers ADD COLUMN tax_id BIGINT NULL');
    await pool.query(
      'ALTER TABLE customers ADD CONSTRAINT customers_tax_fk FOREIGN KEY (tax_id) REFERENCES taxes (id)',
    );
    console.log('Added customers.tax_id.');
  }
}

// requirePermission resolves a route to a `pages` row before it checks anything, so without a row
// the report refuses every user including System Admin, and the nav hides the link.
async function registerPage({ route, name }) {
  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
  if (existing) {
    console.log(`Page ${route} already registered (id ${existing.id}).`);
    return existing.id;
  }
  if (DRY_RUN) {
    console.log(`Would register ${route} as "${name}".`);
    return null;
  }
  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  const has = new Set(cols.map((c) => c.Field));
  const fields = ['route', 'name'];
  const values = [route, name];
  if (has.has('module')) { fields.push('module'); values.push(MODULE); }
  const [result] = await pool.query(
    `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
    values,
  );
  console.log(`Registered ${route} as "${name}" (id ${result.insertId}).`);
  return result.insertId;
}

// Granted in the same run so a report cannot be left registered but unreachable. Nobody else is
// seeded: who may read the company's BIR figures is a decision for whoever owns the filings, not
// something to infer from another report's audience.
async function grantAdmins(pageId, route) {
  if (!pageId) return;
  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE",
  );
  for (const user of admins) {
    const [[existing]] = await pool.query(
      'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, pageId],
    );
    if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get full access to ${route}.`); continue; }
    if (existing) {
      await pool.query(
        'UPDATE user_page_permissions SET can_view = TRUE, can_print = TRUE WHERE id = ?', [existing.id],
      );
    } else {
      await pool.query(
        'INSERT INTO user_page_permissions (user_id, page_id, can_view, can_print) VALUES (?, ?, TRUE, TRUE)',
        [user.id, pageId],
      );
    }
    console.log(`  + ${user.display_name}: ${route}`);
  }
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  await addCustomerColumns();
  console.log('');
  for (const page of PAGES) {
    const id = await registerPage(page);
    await grantAdmins(id, page.route);
  }

  const [[fill]] = await pool.query(
    `SELECT COUNT(*) AS customers,
            SUM(tin IS NOT NULL AND tin <> '') AS with_tin,
            SUM(address IS NOT NULL AND address <> '') AS with_address,
            SUM(tax_id IS NOT NULL) AS with_tax_code
       FROM customers`,
  ).catch(() => [[null]]);
  if (fill) {
    console.log(`\ncustomers: ${fill.customers} total | TIN ${Number(fill.with_tin || 0)} `
      + `| address ${Number(fill.with_address || 0)} | tax code ${Number(fill.with_tax_code || 0)}`);
    console.log('Tax Code and Address print blank until those are filled in.');
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
