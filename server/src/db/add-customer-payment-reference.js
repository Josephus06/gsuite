// Records HOW a customer payment actually arrived, which the form had nowhere to put.
//
// A payment taken by GCASH, Maya, Card or Online Deposit has a reference number, and one taken
// by cheque has a bank, a cheque number and a cheque date -- the date the cheque is drawn for,
// which is not the date the payment was recorded. Without these, a receipt could not be matched
// back to a bank line or a cheque chased when it bounced: the payment said only "CHECK".
//
// Four nullable columns on customer_payments:
//
//   reference_no   GCASH / Maya / Card / Online Deposit reference
//   bank_name      cheque only
//   cheque_no      cheque only
//   cheque_date    cheque only -- when the cheque is dated, not when it was received
//
// ALSO FIXES THE MASTER LIST, which is what decides when the reference field appears:
//
//   - Maya is added. It is a payment method the company takes and the list did not have it,
//     so those receipts were being recorded as something else.
//   - requires_reference was set on CHECK alone. GCASH, Card and Online Deposit/OTC all carry a
//     reference and all had it off, so the flag could not be trusted to drive anything. CASH is
//     deliberately left off: cash has no reference.
//
// The form reads requires_reference rather than matching names, so adding a sixth method later
// is a Master Lists edit and not a code change. The cheque fields are the one exception -- they
// are cheque-specific by nature and keyed off the method named CHECK.
//
// Idempotent -- safe to re-run:
//   node src/db/add-customer-payment-reference.js --dry-run
//   node src/db/add-customer-payment-reference.js
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

const COLUMNS = [
  ['reference_no', 'VARCHAR(100) NULL'],
  ['bank_name', 'VARCHAR(150) NULL'],
  ['cheque_no', 'VARCHAR(60) NULL'],
  ['cheque_date', 'DATE NULL'],
];

// Everything that arrives with a reference. CASH is absent on purpose.
const NEEDS_REFERENCE = ['GCASH', 'Maya', 'Card', 'Online Deposit/OTC', 'CHECK'];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ? AND COLUMN_NAME = ?`,
    [process.env.DB_NAME, table, column],
  );
  return rows.length > 0;
}

async function addColumns() {
  for (const [name, ddl] of COLUMNS) {
    if (await columnExists('customer_payments', name)) {
      console.log(`customer_payments.${name} already present.`);
    } else if (DRY_RUN) {
      console.log(`Would add customer_payments.${name}.`);
    } else {
      await pool.query(`ALTER TABLE customer_payments ADD COLUMN ${name} ${ddl}`);
      console.log(`Added customer_payments.${name}.`);
    }
  }
}

async function fixMethods() {
  const [methods] = await pool.query('SELECT id, name, requires_reference FROM payment_methods');
  const byName = new Map(methods.map((m) => [norm(m.name), m]));

  if (byName.has(norm('Maya'))) {
    console.log('Payment method "Maya" already present.');
  } else if (DRY_RUN) {
    console.log('Would add payment method "Maya".');
  } else {
    const [r] = await pool.query(
      'INSERT INTO payment_methods (name, requires_reference, is_active) VALUES (?, TRUE, TRUE)', ['Maya'],
    );
    console.log(`Added payment method "Maya" (id ${r.insertId}).`);
    byName.set(norm('Maya'), { id: r.insertId, name: 'Maya', requires_reference: 1 });
  }

  for (const name of NEEDS_REFERENCE) {
    const m = byName.get(norm(name));
    if (!m) { console.log(`!! No payment method named "${name}" -- skipped.`); continue; }
    if (m.requires_reference) { console.log(`${m.name}: already requires a reference.`); continue; }
    if (DRY_RUN) { console.log(`Would set requires_reference on ${m.name}.`); continue; }
    await pool.query('UPDATE payment_methods SET requires_reference = TRUE WHERE id = ?', [m.id]);
    console.log(`${m.name}: requires_reference set.`);
  }
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  await addColumns();
  console.log('');
  await fixMethods();

  const [methods] = await pool.query(
    'SELECT name, requires_reference FROM payment_methods WHERE is_active = TRUE ORDER BY name',
  );
  console.log('\nactive payment methods:');
  methods.forEach((m) => console.log(`  ${String(m.name).padEnd(22)}${m.requires_reference ? 'reference required' : 'no reference'}`));
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
