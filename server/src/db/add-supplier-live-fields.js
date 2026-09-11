// Widens `suppliers` to hold what the live system actually keeps about a supplier, ahead of
// importing them.
//
// The 915 rows already here are stubs: a name and a locally generated SUP-### code, created as a
// side effect of importing purchase orders. Live holds address, TIN, contact numbers, credit terms
// and payee/bank details for the same companies -- none of which has anywhere to go until now.
//
// live_pk is the important one. Without it every future re-run has to match on NAME, which works
// today only because every local name happens to match live exactly. Once the link is stored, a
// supplier that gets renamed on either side is still the same supplier.
//
// CREDIT TERM IS STORED AS TEXT, not mapped to a lookup. There is no payment_terms table here, and
// live's values are free text with inconsistent casing -- "30 DAYS", "30 Days", "30 DAYS PDC",
// "50%DP - 50%DLVRY". Inventing a lookup would mean deciding that "30 Days" and "30 DAYS" are the
// same term and that "50%DP-30%BILLING-20%COMPLETION" is one too; that is a decision for whoever
// owns purchasing, not for an importer. The numeric days come across separately.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-supplier-live-fields.js
const pool = require('../db');

const COLUMNS = [
  ['live_pk', 'VARCHAR(64) NULL AFTER id'],
  ['live_id', 'INT NULL AFTER live_pk'],
  ['address', 'VARCHAR(500) NULL AFTER company_name'],
  ['contact_no', 'VARCHAR(120) NULL AFTER address'],
  ['mobile_no', 'VARCHAR(120) NULL AFTER contact_no'],
  ['office_no', 'VARCHAR(120) NULL AFTER mobile_no'],
  ['fax_no', 'VARCHAR(120) NULL AFTER office_no'],
  ['email', 'VARCHAR(200) NULL AFTER fax_no'],
  ['credit_term', 'VARCHAR(120) NULL AFTER tin'],
  ['term_days', 'INT NULL AFTER credit_term'],
  ['payee_name', 'VARCHAR(200) NULL AFTER term_days'],
  ['bank_name', 'VARCHAR(200) NULL AFTER payee_name'],
  ['bank_account_name', 'VARCHAR(200) NULL AFTER bank_name'],
  ['bank_account_no', 'VARCHAR(120) NULL AFTER bank_account_name'],
];

// `tin` shipped as VARCHAR(30), which fits one TIN and nothing else. Live holds up to 141
// characters there, because a supplier with several registered branches keeps them in one field:
// "208-123-218-00010 - LABOGON BRANCH; 208-123-218-003 - LAHUG;". Truncating that to 30 would cut
// a TIN in half and leave a string that still LOOKS like a valid one, which is the worst outcome
// available -- so the column is widened instead.
const WIDEN = [['tin', 160]];

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function indexExists(table, name) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, [table, name],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  for (const [column, ddl] of COLUMNS) {
    if (await columnExists('suppliers', column)) {
      console.log(`  suppliers.${column} already exists -- skipped.`);
    } else {
      await pool.query(`ALTER TABLE suppliers ADD COLUMN ${column} ${ddl}`);
      console.log(`  suppliers.${column} added.`);
    }
  }

  for (const [column, width] of WIDEN) {
    const [[c]] = await pool.query(
      `SELECT character_maximum_length AS len FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'suppliers' AND column_name = ?`, [column],
    );
    if (c && Number(c.len) < width) {
      await pool.query(`ALTER TABLE suppliers MODIFY COLUMN ${column} VARCHAR(${width}) NULL`);
      console.log(`  suppliers.${column} widened from varchar(${c.len}) to varchar(${width}).`);
    } else {
      console.log(`  suppliers.${column} is already varchar(${c?.len}) -- skipped.`);
    }
  }

  // UNIQUE, so a re-run of the importer cannot create a second local row for one live supplier.
  // Nullable, because rows that were never matched to live keep a NULL and MySQL allows many of
  // those in a unique index.
  if (await indexExists('suppliers', 'uq_suppliers_live_pk')) {
    console.log('  index uq_suppliers_live_pk already exists -- skipped.');
  } else {
    await pool.query('ALTER TABLE suppliers ADD UNIQUE KEY uq_suppliers_live_pk (live_pk)');
    console.log('  index uq_suppliers_live_pk added.');
  }

  const [[s]] = await pool.query(
    'SELECT COUNT(*) AS total, SUM(live_pk IS NOT NULL) AS linked FROM suppliers');
  console.log(`\n${s.total} suppliers locally, ${Number(s.linked) || 0} linked to live.`);
  console.log('Run import-suppliers.js next.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
