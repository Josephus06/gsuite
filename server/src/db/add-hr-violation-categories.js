// Makes the violation category a fixed list rather than free text, and widens the columns that
// hold it.
//
// The eight headings are the company's own, the ones its code of conduct is organised under. Two
// of them do not fit the VARCHAR(60) the table shipped with:
//
//   78  Offenses against Decency, Good Custom, Honor, Morality, Honesty, and Integrity
//   72  Offenses against Cleanliness, Safety, Health, Security, and Public Order
//
// Under MySQL's strict mode that is an error on save, not a silent trim -- so HR would simply have
// been unable to file anything under either heading. Both columns go to VARCHAR(120): the lookup's
// own, and the snapshot the charge keeps.
//
// IDEMPOTENT: safe to re-run. Existing values are untouched -- widening a VARCHAR does not rewrite
// rows, and nothing here maps old free-text categories onto the new list, because guessing which
// heading someone meant is exactly the kind of edit a disciplinary record should never receive.
//
//   node src/db/add-hr-violation-categories.js
const pool = require('../db');

const WIDEN = [
  ['hr_violation_types', 'category'],
  ['hr_violations', 'violation_category'],
];
const TARGET = 120;

async function columnType(table, column) {
  const [[r]] = await pool.query(
    `SELECT character_maximum_length AS len FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r ? Number(r.len) : null;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  for (const [table, column] of WIDEN) {
    const len = await columnType(table, column);
    if (len === null) {
      console.log(`  ${table}.${column} does not exist -- skipped.`);
    } else if (len >= TARGET) {
      console.log(`  ${table}.${column} is already varchar(${len}) -- skipped.`);
    } else {
      await pool.query(`ALTER TABLE ${table} MODIFY COLUMN ${column} VARCHAR(${TARGET}) NULL`);
      console.log(`  ${table}.${column} widened from varchar(${len}) to varchar(${TARGET}).`);
    }
  }

  // Anything already recorded under a heading that is not on the list. Reported rather than
  // changed: the list is new, and an existing charge cites the wording it was filed under.
  const [[odd]] = await pool.query(
    `SELECT COUNT(*) AS n FROM hr_violation_types
      WHERE category IS NOT NULL AND category <> ''`,
  );
  console.log(`\n${odd.n} violation(s) currently carry a category.`);
  console.log('The category is now a fixed dropdown of the eight headings from the code of conduct.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
