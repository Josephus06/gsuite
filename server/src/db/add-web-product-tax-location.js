// Adds web_products.tax_id and web_products.office_location_id.
//
// The quote table shows a Tax Code, Tax Amt and Gross Amt, and the API reads them off the
// product rather than hard-coding a rate -- a VAT change should be a setting, not a deploy.
//
// WHY THIS FILE EXISTS AT ALL. These two columns were first added with a one-off command against
// the local database and never written down, so the join went out in the API while Railway's
// table still had neither column. The result was "Unknown column 'p.tax_id' in 'on clause'" on
// the live site the moment CORS started letting requests through. Schema changes belong in a
// script that can be run against every environment, which is what this is.
//
// Defaults are applied only where the column is still empty, so a product someone has already
// pointed at a different tax code or branch keeps it.
//
// Idempotent -- safe to re-run:
//   node src/db/add-web-product-tax-location.js
const pool = require('../db');
require('dotenv').config();

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [cols] = await pool.query(
    `SELECT COLUMN_NAME AS cn FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'web_products'
        AND COLUMN_NAME IN ('tax_id', 'office_location_id')`,
    [process.env.DB_NAME]
  );
  const have = new Set(cols.map((c) => c.cn));

  for (const [name, ddl] of [['office_location_id', 'BIGINT NULL'], ['tax_id', 'BIGINT NULL']]) {
    if (have.has(name)) { console.log(`web_products.${name} already present.`); continue; }
    await pool.query(`ALTER TABLE web_products ADD COLUMN ${name} ${ddl}`);
    console.log(`web_products.${name} added.`);
  }

  // Resolved by code/name rather than id -- these differ between local and Railway.
  const [[tax]] = await pool.query("SELECT id, code FROM taxes WHERE code = 'VAT12' LIMIT 1");
  const [[loc]] = await pool.query("SELECT id, location_name FROM locations WHERE location_name LIKE '%SM%' ORDER BY id LIMIT 1");
  if (!tax) console.log('!! No VAT12 tax code found -- products will quote without tax until one is set.');
  if (!loc) console.log('!! No branch matched -- office_location_id left unset.');

  const [r] = await pool.query(
    'UPDATE web_products SET tax_id = COALESCE(tax_id, ?), office_location_id = COALESCE(office_location_id, ?)',
    [tax?.id || null, loc?.id || null]
  );
  console.log(`defaults applied to ${r.affectedRows} product(s): tax ${tax?.code || 'none'}, location ${loc?.location_name || 'none'}`);

  const [[n]] = await pool.query(
    'SELECT COUNT(*) AS n, SUM(tax_id IS NOT NULL) AS with_tax FROM web_products'
  );
  console.log(`web_products: ${n.n} total, ${Number(n.with_tax || 0)} with a tax code.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
