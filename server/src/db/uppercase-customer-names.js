// Upper-cases every existing customer name and company name, to match what the app now stores
// on the way in (see lib/customerName.js).
//
// TWO THINGS TO KNOW BEFORE RUNNING THIS.
//
// 1. It is not reversible from the data itself -- "ACME CORP" does not remember whether it was
//    typed "Acme Corp" or "acme corp". So it writes a rollback file of UPDATE statements next to
//    itself BEFORE changing anything, and refuses to run if it cannot. Keep that file until the
//    change has been lived with.
//
// 2. The obvious check for what needs changing is wrong on this schema. customers is
//    utf8mb4_unicode_ci, a CASE-INSENSITIVE collation, so `WHERE name <> UPPER(name)` compares
//    'acme' against 'ACME' as equal and matches NOTHING -- it reports a database that is already
//    perfect no matter how mixed its casing is. Every comparison here is forced through BINARY
//    for that reason.
//
// Names only. Contact names and street addresses are left alone: they are people and places, not
// the customer identity the list is keyed on.
const fs = require('fs');
const path = require('path');
const pool = require('../db');

const COLUMNS = ['name', 'company_name'];
// BINARY on both sides, so the comparison is byte-for-byte rather than collation-folded.
const NEEDS_CHANGE = COLUMNS
  .map((c) => `(${c} IS NOT NULL AND BINARY ${c} <> BINARY UPPER(${c}))`)
  .join(' OR ');

const sqlEscape = (v) => (v === null ? 'NULL' : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`);

(async () => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, company_name FROM customers WHERE ${NEEDS_CHANGE} ORDER BY id`
    );
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM customers');
    console.log(`${total} customers; ${rows.length} with a name or company not already upper-case.`);
    if (!rows.length) { console.log('Nothing to do.'); process.exit(0); }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const rollbackPath = path.join(__dirname, `rollback-customer-names-${stamp}.sql`);
    const rollback = [
      '-- Restores customer names as they were before uppercase-customer-names.js ran.',
      `-- Generated ${new Date().toISOString()} for ${rows.length} rows.`,
      ...rows.map((r) => `UPDATE customers SET name = ${sqlEscape(r.name)}, company_name = ${sqlEscape(r.company_name)} WHERE id = ${r.id};`),
      '',
    ].join('\n');
    fs.writeFileSync(rollbackPath, rollback, 'utf8');
    console.log(`Rollback written to ${rollbackPath}`);

    // Done in the database rather than row by row from here: 2k+ round trips to change a string
    // is a slow way to hold a lock on a table the whole app reads. UPPER() is Unicode-aware, so
    // accented names keep their accents.
    const [res] = await pool.query(
      `UPDATE customers
          SET name = UPPER(name),
              company_name = CASE WHEN company_name IS NULL THEN NULL ELSE UPPER(company_name) END,
              updated_at = NOW()
        WHERE ${NEEDS_CHANGE}`
    );
    console.log(`Updated ${res.affectedRows} customers.`);

    const [[{ remaining }]] = await pool.query(
      `SELECT COUNT(*) AS remaining FROM customers WHERE ${NEEDS_CHANGE}`
    );
    console.log(remaining === 0 ? 'Verified: every customer name is upper-case.' : `STILL MIXED CASE: ${remaining} -- investigate.`);
    process.exit(remaining === 0 ? 0 : 1);
  } catch (err) { console.error(err); process.exit(1); }
})();
