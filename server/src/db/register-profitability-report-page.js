// One-off migration: registers Accounting > Reports > Profitability Report in the `pages` table,
// and adds the two indexes the report needs.
//
// WHY THE PAGE ROW. requirePermission resolves a route to a `pages` row before it checks anything,
// so without this row /reports/profitability refuses every user including System Admin -- and
// refuses them with a 500 rather than a 403 on installs where the lookup throws. Admins are
// granted full access in the same run so the report can never be left registered-but-unreachable.
//
// WHY THE INDEXES. The report reads Actual Revenue two ways, and neither had an index:
//
//   sales_invoice_lines.job_order_id   how a line's invoiced amount is found (121,012 rows, the
//                                      table's only index was on sales_invoice_id)
//   sales_invoices.sales_order_id      how an order's billed total is found (73,675 rows, indexed
//                                      on date_created and estimate_id but not on this)
//
// Without them every page of the report full-scans both tables. They cost a few MB each and take
// both lookups to a keyed read. Created here, idempotently, rather than in schema.sql, because
// every install already has these tables and only a migration reaches them. Production (Railway)
// applies migrations by hand -- run this there too.
//
// Idempotent -- safe to re-run:
//   node src/db/register-profitability-report-page.js --dry-run   (report only)
//   node src/db/register-profitability-report-page.js             (apply)
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const ROUTE = '/reports/profitability';
const NAME = 'Profitability Report';
const MODULE = 'Accounting';
const INDEXES = [
  { name: 'idx_sil_job_order_id', table: 'sales_invoice_lines', column: 'job_order_id' },
  { name: 'idx_sales_invoices_sales_order_id', table: 'sales_invoices', column: 'sales_order_id' },
];

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`Page ${ROUTE} already registered (id ${page.id}).`);
  } else if (DRY_RUN) {
    console.log(`Would register ${ROUTE} as "${NAME}".`);
  } else {
    // `module` and `sort_order` are not in schema.sql's own definition of this table but exist on
    // the migrated installs, so they are set only where they are present -- the same check
    // register-commission-report-page.js makes.
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
  } else {
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
  }

  console.log('');
  for (const idx of INDEXES) {
    const [existing] = await pool.query(`SHOW INDEX FROM ${idx.table} WHERE Key_name = ?`, [idx.name]);
    if (existing.length) {
      console.log(`Index ${idx.name} already exists.`);
    } else if (DRY_RUN) {
      console.log(`Would create index ${idx.name} on ${idx.table} (${idx.column}).`);
    } else {
      await pool.query(`CREATE INDEX ${idx.name} ON ${idx.table} (${idx.column})`);
      console.log(`Created index ${idx.name} on ${idx.table} (${idx.column}).`);
    }
  }

  // Dropped, not left behind: an earlier run of this script created it for a lookup the report
  // turned out not to be able to use (sales_invoice_lines.sales_order_line_id holds unmapped
  // source-system ids -- see lib/profitabilityReport.js). Nothing reads it, and an unused index
  // on a 121k-row table is write cost for no read.
  const [stale] = await pool.query("SHOW INDEX FROM sales_invoice_lines WHERE Key_name = 'idx_sil_sales_order_line_id'");
  if (stale.length) {
    if (DRY_RUN) {
      console.log('Would drop unused index idx_sil_sales_order_line_id on sales_invoice_lines.');
    } else {
      await pool.query('DROP INDEX idx_sil_sales_order_line_id ON sales_invoice_lines');
      console.log('Dropped unused index idx_sil_sales_order_line_id on sales_invoice_lines.');
    }
  }

  await pool.end();
}

main().catch((err) => { console.error('Registration failed:', err); process.exit(1); });
