// The inputs the costing team's workbook (Documents/costing.xlsx, 2026-09-30) carries per quantity
// bracket that process_cost_brackets did not:
//   new_ink_cost             "New INK Cost" -- recorded beside INK, not used in any formula
//   markup_opex_admin_pct    "Mark-Up OPEX(Admin)" %
//   markup_opex_selling_pct  "Mark-Up OPEX(Selling)" %
//   markup_sub_con_pct       "Mark-Up Sub Con" %
//   costing_reference        "Costing Reference"
// All default to 0 / NULL, so every existing bracket prices exactly as before apart from the
// SubTotal change in shared/costing.js. The formulas themselves live there.
//
// Idempotent -- safe to re-run, and --env picks the install:
//   node src/db/add-process-costing-workbook-cols.js
//   node src/db/add-process-costing-workbook-cols.js --env=railway
const envName = require('./lib/env')();
const pool = require('../db');

const TABLE = 'process_cost_brackets';
const COLUMNS = [
  ['new_ink_cost', 'ADD COLUMN new_ink_cost DECIMAL(14,4) NULL DEFAULT 0 AFTER click_charge'],
  ['markup_opex_admin_pct', 'ADD COLUMN markup_opex_admin_pct DECIMAL(6,2) NULL DEFAULT 0 AFTER opex_admin_pct'],
  ['markup_opex_selling_pct', 'ADD COLUMN markup_opex_selling_pct DECIMAL(6,2) NULL DEFAULT 0 AFTER opex_selling_pct'],
  ['markup_sub_con_pct', 'ADD COLUMN markup_sub_con_pct DECIMAL(6,2) NULL DEFAULT 0 AFTER sub_con'],
  ['costing_reference', 'ADD COLUMN costing_reference VARCHAR(100) NULL AFTER selling_price_override'],
];

async function main() {
  console.log(`Target DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${envName ? ` (--env=${envName})` : ''}`);
  const [existing] = await pool.query('SHOW COLUMNS FROM ??', [TABLE]);
  const have = new Set(existing.map((c) => c.Field));
  for (const [name, ddl] of COLUMNS) {
    if (have.has(name)) { console.log(`${name} already present.`); continue; }
    await pool.query(`ALTER TABLE ${TABLE} ${ddl}`);
    console.log(`Added ${name}.`);
  }
  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
