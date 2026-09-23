// Collection Forecast: lets Treasury put a date on an open invoice saying when they expect to
// collect it, and registers the page that does it.
//
// Three columns on sales_invoices, all nullable -- an invoice with no forecast is simply one
// nobody has planned yet, which is the starting state for all 1,882 currently open:
//
//   collection_forecast_date          when Treasury expects to collect. The whole feature.
//   collection_forecast_set_by_user_id  who set it
//   collection_forecast_set_at          when they set it
//
// The two audit columns are not decoration. A forecast date is a promise someone made on a
// customer's behalf, and when the money does not arrive the first question is who expected it
// and when they last looked -- a bare date cannot answer that, and the invoice's own audit log
// is about the invoice, not about a collection plan laid over it.
//
// INDEXED on the forecast date because the calendar asks "everything forecast in this month"
// against 74,284 invoices, and that is the one query that runs every time the month is paged.
//
// The worklist is invoices with amount_due > 0 and no cancellation -- what the Invoice screen
// itself calls outstanding. Note that AR Aging deliberately answers a different question: it
// rebuilds balances from documents and so also counts 1,363 invoices marked paid with no
// payment recorded behind them. Treasury chasing an invoice its own screen calls Paid In Full
// would be worse than the two reports differing, so this follows the screen. See lib/arAging.js.
//
// Idempotent -- safe to re-run:
//   node src/db/add-collection-forecast.js --dry-run
//   node src/db/add-collection-forecast.js
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const ROUTE = '/treasury/collection-forecast';
const NAME = 'Collection Forecast';
const MODULE = 'Treasury';

const COLUMNS = [
  ['collection_forecast_date', 'DATE NULL'],
  ['collection_forecast_set_by_user_id', 'BIGINT NULL'],
  ['collection_forecast_set_at', 'DATETIME NULL'],
];

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ? AND COLUMN_NAME = ?`,
    [process.env.DB_NAME, table, column],
  );
  return rows.length > 0;
}

async function indexExists(table, name) {
  const [rows] = await pool.query(
    `SELECT INDEX_NAME FROM information_schema.statistics
      WHERE table_schema = ? AND table_name = ? AND INDEX_NAME = ?`,
    [process.env.DB_NAME, table, name],
  );
  return rows.length > 0;
}

async function addColumns() {
  for (const [name, ddl] of COLUMNS) {
    if (await columnExists('sales_invoices', name)) {
      console.log(`sales_invoices.${name} already present.`);
    } else if (DRY_RUN) {
      console.log(`Would add sales_invoices.${name}.`);
    } else {
      await pool.query(`ALTER TABLE sales_invoices ADD COLUMN ${name} ${ddl}`);
      console.log(`Added sales_invoices.${name}.`);
    }
  }

  if (await indexExists('sales_invoices', 'idx_sales_invoices_collection_forecast')) {
    console.log('idx_sales_invoices_collection_forecast already present.');
  } else if (DRY_RUN) {
    console.log('Would add idx_sales_invoices_collection_forecast.');
  } else if (await columnExists('sales_invoices', 'collection_forecast_date')) {
    await pool.query(
      'CREATE INDEX idx_sales_invoices_collection_forecast ON sales_invoices (collection_forecast_date)',
    );
    console.log('Added idx_sales_invoices_collection_forecast.');
  }
}

// requirePermission resolves a route to a `pages` row before it checks anything, so without this
// the page refuses every user including System Admin and the nav hides it.
async function registerPage() {
  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (existing) {
    console.log(`Page ${ROUTE} already registered (id ${existing.id}).`);
    return existing.id;
  }
  if (DRY_RUN) {
    console.log(`Would register ${ROUTE} as "${NAME}".`);
    return null;
  }
  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  const has = new Set(cols.map((c) => c.Field));
  const fields = ['route', 'name'];
  const values = [ROUTE, NAME];
  if (has.has('module')) { fields.push('module'); values.push(MODULE); }
  const [result] = await pool.query(
    `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
    values,
  );
  console.log(`Registered ${ROUTE} as "${NAME}" (id ${result.insertId}).`);
  return result.insertId;
}

// Admins only, and deliberately nobody else: who may commit the company to a collection date is
// Treasury's call, not something to infer from who can already see invoices. Grant the actual
// treasury people from Users & Permissions afterwards -- can_view to read the calendar,
// can_edit to set dates.
async function grantAdmins(pageId) {
  if (!pageId) return;
  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE",
  );
  for (const user of admins) {
    const [[existing]] = await pool.query(
      'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, pageId],
    );
    if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get view + edit.`); continue; }
    if (existing) {
      await pool.query(
        'UPDATE user_page_permissions SET can_view = TRUE, can_edit = TRUE WHERE id = ?', [existing.id],
      );
    } else {
      await pool.query(
        'INSERT INTO user_page_permissions (user_id, page_id, can_view, can_edit) VALUES (?, ?, TRUE, TRUE)',
        [user.id, pageId],
      );
    }
    console.log(`  + ${user.display_name}: view + edit.`);
  }
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  await addColumns();
  console.log('');
  const pageId = await registerPage();
  await grantAdmins(pageId);

  const [[open]] = await pool.query(
    `SELECT COUNT(*) AS open_invoices, COALESCE(SUM(amount_due), 0) AS outstanding
       FROM sales_invoices WHERE amount_due > 0 AND cancelled_at IS NULL`,
  );
  console.log(`\n${Number(open.open_invoices).toLocaleString()} open invoice(s), `
    + `${Number(open.outstanding).toLocaleString('en-US', { minimumFractionDigits: 2 })} outstanding, `
    + 'none forecast yet.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
