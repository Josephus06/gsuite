// One-off migration: reshapes the NSTDJO Materials grid columns to match the form.
//
//   Process | Qty | Item | Length | Width | Qty | UOM | Total | Unit | Process Price
//         | Artist Incentive | Artist Remarks | Sales Remarks
//
// Adds process_qty / process_price / artist_incentive and drops category / parts, which
// the form no longer collects. Idempotent -- safe to re-run:
//   node src/db/alter-nstdjo-materials.js
const pool = require('../db');
require('dotenv').config();

const TABLE = 'non_standard_job_order_materials';

async function columns() {
  const [rows] = await pool.query('SHOW COLUMNS FROM ??', [TABLE]);
  return new Set(rows.map((r) => r.Field));
}

async function main() {
  // The detail view shows an Artist on the header (blank until Design assigns one --
  // the live site leaves it empty on a freshly raised order too).
  const [headerCols] = await pool.query('SHOW COLUMNS FROM non_standard_job_orders');
  if (headerCols.some((c) => c.Field === 'artist_employee_id')) {
    console.log('artist_employee_id already present.');
  } else {
    await pool.query('ALTER TABLE non_standard_job_orders ADD COLUMN artist_employee_id BIGINT NULL AFTER sales_rep_id');
    console.log('Added artist_employee_id.');
  }

  let existing = await columns();

  for (const [name, ddl] of [
    ['process_qty', 'ADD COLUMN process_qty DECIMAL(14,4) NULL AFTER process_id'],
    ['process_price', 'ADD COLUMN process_price DECIMAL(14,4) NULL AFTER process_qty'],
    // Artist's cut of the process price (5%), stored rather than derived on read so a
    // later change to the rate cannot silently restate what past job orders paid out.
    ['artist_incentive', 'ADD COLUMN artist_incentive DECIMAL(14,4) NULL AFTER process_price'],
  ]) {
    if (existing.has(name)) { console.log(`${name} already present.`); continue; }
    await pool.query(`ALTER TABLE ${TABLE} ${ddl}`);
    console.log(`Added ${name}.`);
  }

  // Only dropped once nothing depends on them -- refuse if any row still carries data.
  for (const name of ['category', 'parts']) {
    if (!existing.has(name)) { console.log(`${name} already dropped.`); continue; }
    const [[{ used }]] = await pool.query(
      `SELECT COUNT(*) AS used FROM ${TABLE} WHERE ?? IS NOT NULL AND ?? <> ''`, [name, name],
    );
    if (used) {
      console.warn(`Skipping drop of ${name}: ${used} row(s) still have a value. Clear them first.`);
      continue;
    }
    await pool.query(`ALTER TABLE ${TABLE} DROP COLUMN ??`, [name]);
    console.log(`Dropped ${name}.`);
  }

  existing = await columns();
  console.log('\nMaterials columns now:', [...existing].join(', '));
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
