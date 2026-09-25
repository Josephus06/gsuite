// Adds a Reason to each Quality Inspection line: quality_inspection_lines.reason_id.
//
// A line with RMA Qty above zero now has to say WHY it failed, picked from Master Lists > Reasons
// (types RFQC / RMA), alongside its RMA Memo and Action/s to be taken. The reason is also carried
// onto the RFQC rework job order the RMA qty creates, as its reason_code_id.
//
// Appended with no AFTER clause, so MySQL 8 adds it instantly without rebuilding the table.
// IDEMPOTENT: checks for the column first.
//
//   node src/db/add-qi-line-reason.js --dry-run
//   node src/db/add-qi-line-reason.js
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  const [cols] = await pool.query("SHOW COLUMNS FROM quality_inspection_lines LIKE 'reason_id'");
  if (cols.length) console.log('quality_inspection_lines.reason_id already exists -- skipping.');
  else if (DRY_RUN) console.log('Would add quality_inspection_lines.reason_id BIGINT NULL.');
  else {
    await pool.query('ALTER TABLE quality_inspection_lines ADD COLUMN reason_id BIGINT NULL');
    console.log('Added quality_inspection_lines.reason_id.');
  }
  await pool.end();
}

main().catch(async (err) => { console.error('Migration failed:', err.message); await pool.end(); process.exit(1); });
