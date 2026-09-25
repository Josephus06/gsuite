// Adds RFQC and RMA to the reason types (Master Lists > Reasons > Type).
//
// reasons.reason_type is an ENUM, so the dropdown alone cannot offer a new type -- saving one
// would be refused by the database. The values are APPENDED, never inserted between existing
// ones: appending is an instant metadata change in MySQL 8, where reordering would rewrite the
// table and renumber every stored value.
//
// IDEMPOTENT: reads the column first and only adds what is missing.
//
//   node src/db/add-reason-types-rfqc-rma.js --dry-run
//   node src/db/add-reason-types-rfqc-rma.js
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const ADD = ['RFQC', 'RMA'];

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  const [[col]] = await pool.query(
    `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'reasons' AND column_name = 'reason_type'`
  );
  if (!col) throw new Error('reasons.reason_type not found.');
  // enum('A','B') -> ['A', 'B']
  const current = [...col.type.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  const missing = ADD.filter((v) => !current.includes(v));
  console.log(`Current types: ${current.join(', ')}`);
  if (!missing.length) { console.log('RFQC and RMA already present -- nothing to do.'); await pool.end(); return; }

  const next = [...current, ...missing];
  const sql = `ALTER TABLE reasons MODIFY COLUMN reason_type ENUM(${next.map((v) => pool.escape(v)).join(', ')})`
    + `${col.nullable === 'NO' ? ' NOT NULL' : ' NULL'}`;
  if (DRY_RUN) { console.log(`Would run: ${sql}`); await pool.end(); return; }
  await pool.query(sql);

  const [[after]] = await pool.query(
    `SELECT COLUMN_TYPE AS type FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'reasons' AND column_name = 'reason_type'`
  );
  console.log(`Now: ${after.type}`);
  await pool.end();
}

main().catch(async (err) => { console.error('Migration failed:', err.message); await pool.end(); process.exit(1); });
