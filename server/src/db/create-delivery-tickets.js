// One-off migration: creates the Delivery Ticket tables and registers its page.
//
// A Delivery Ticket is its own transaction type (DT-####), not a flavour of Sales
// Invoice -- see the block comment above delivery_tickets in schema.sql for why, and for
// why it posts to "Accounts Receivable Trade - Unbilled" (12101) rather than AR Trade.
//
// The page row is registered and admins granted full access in this same migration, so
// the module can never be left unreachable: requirePermission resolves a route to a page
// before it checks anything, so a missing row 403s every user including System Admin.
//
// Idempotent -- safe to re-run:
//   node src/db/create-delivery-tickets.js --dry-run   (report only, no writes)
//   node src/db/create-delivery-tickets.js             (apply)
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const ROUTE = '/delivery-tickets';
const NAME = 'Delivery Tickets';
const MODULE = 'Sales';
const UNBILLED_AR_CODE = '12101';

const CREATE_TICKETS = `
CREATE TABLE delivery_tickets (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    dt_no VARCHAR(30) UNIQUE NOT NULL,
    sales_order_id BIGINT NOT NULL,
    date_created DATE NOT NULL,
    date_due DATE NULL,
    term VARCHAR(60),
    po_no VARCHAR(60),
    sales_rep_id BIGINT NULL,
    office_location_id BIGINT NULL,
    department_id BIGINT NULL,
    memo VARCHAR(500),
    subtotal DECIMAL(14,2) DEFAULT 0,
    discount_amount DECIMAL(14,2) DEFAULT 0,
    net_of_tax DECIMAL(14,2) DEFAULT 0,
    tax_amount DECIMAL(14,2) DEFAULT 0,
    gross_amount DECIMAL(14,2) DEFAULT 0,
    amount_due DECIMAL(14,2) DEFAULT 0,
    status VARCHAR(30) DEFAULT 'open',
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_by_user_id BIGINT NULL,
    voided_at DATETIME NULL,
    INDEX idx_dt_sales_order (sales_order_id)
)`;

const CREATE_LINES = `
CREATE TABLE delivery_ticket_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    delivery_ticket_id BIGINT NOT NULL,
    line_no INT NOT NULL,
    sales_order_line_id BIGINT NULL,
    job_order_id BIGINT NULL,
    item_id BIGINT NULL,
    item_name VARCHAR(255),
    description VARCHAR(500),
    location_id BIGINT NULL,
    quantity DECIMAL(14,4),
    units VARCHAR(30),
    unit_title VARCHAR(60),
    price_per_unit DECIMAL(14,4),
    subtotal DECIMAL(14,2),
    disc_percent DECIMAL(5,2),
    disc_per_unit DECIMAL(14,4),
    disc_amount DECIMAL(14,2),
    disc_price_per_unit DECIMAL(14,4),
    net_of_tax DECIMAL(14,2),
    tax_code VARCHAR(30),
    tax_amount DECIMAL(14,2),
    gross_amount DECIMAL(14,2),
    INDEX idx_dtl_ticket (delivery_ticket_id)
)`;

async function tableExists(name) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return rows.length > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  for (const [name, ddl] of [['delivery_tickets', CREATE_TICKETS], ['delivery_ticket_lines', CREATE_LINES]]) {
    if (await tableExists(name)) {
      console.log(`Table ${name} already exists.`);
    } else if (DRY_RUN) {
      console.log(`Would create table ${name}.`);
    } else {
      await pool.query(ddl);
      console.log(`Created table ${name}.`);
    }
  }

  // Billing a Delivery Ticket raises a Sales Invoice from it (the DT's own Bill > SI
  // button), so the invoice has to point back at the ticket it converted -- that link is
  // what flips the ticket to 'converted' and what its Related Records tab reads.
  const [siCols] = await pool.query('SHOW COLUMNS FROM sales_invoices');
  if (siCols.some((c) => c.Field === 'delivery_ticket_id')) {
    console.log('\nsales_invoices.delivery_ticket_id already present.');
  } else if (DRY_RUN) {
    console.log('\nWould add sales_invoices.delivery_ticket_id.');
  } else {
    await pool.query('ALTER TABLE sales_invoices ADD COLUMN delivery_ticket_id BIGINT NULL AFTER sales_order_id');
    console.log('\nAdded sales_invoices.delivery_ticket_id.');
  }

  // A DT line raised by "Add Item" (a delivery fee, a mobilisation charge) has no
  // sales_order_line behind it, so an invoice billing that ticket can't supply one
  // either. The column was NOT NULL from when every invoice line necessarily came off
  // the order; billing a DT is the first case where that stops being true.
  const [silCols] = await pool.query('SHOW COLUMNS FROM sales_invoice_lines');
  const soLineCol = silCols.find((c) => c.Field === 'sales_order_line_id');
  if (soLineCol && soLineCol.Null === 'YES') {
    console.log('sales_invoice_lines.sales_order_line_id already nullable.');
  } else if (DRY_RUN) {
    console.log('Would make sales_invoice_lines.sales_order_line_id nullable.');
  } else {
    await pool.query('ALTER TABLE sales_invoice_lines MODIFY sales_order_line_id BIGINT NULL');
    console.log('Made sales_invoice_lines.sales_order_line_id nullable.');
  }

  // The GL entry debits this account, so a database without it would post a one-sided
  // entry. Reported rather than created -- inventing a chart-of-accounts row is a
  // decision for whoever owns the CoA, not this migration.
  const [[unbilled]] = await pool.query(
    'SELECT id, account_name FROM chart_of_accounts WHERE account_code = ?', [UNBILLED_AR_CODE],
  );
  if (unbilled) {
    console.log(`\nGL account ${UNBILLED_AR_CODE} present: "${unbilled.account_name}".`);
  } else {
    console.warn(`\n!! No chart_of_accounts row for ${UNBILLED_AR_CODE} (Accounts Receivable Trade - Unbilled).`);
    console.warn('   Delivery Tickets will show an empty GL Impact tab until it is added.');
  }

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`\nPage ${ROUTE} already registered (id ${page.id}).`);
  } else if (DRY_RUN) {
    console.log(`\nWould register ${ROUTE} as "${NAME}".`);
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
    console.log(`\nRegistered ${ROUTE} as "${NAME}" (id ${page.id}).`);
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
      if (DRY_RUN) {
        console.log(`  ~ ${user.display_name}: would get full access.`);
        continue;
      }
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

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
