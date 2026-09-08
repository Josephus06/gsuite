// Lets an artist archive the working files for a job order they were assigned.
//
// The point of the archive is that the layout files for JO-12345 can be found again in three
// years. So the job order's details are SNAPSHOTTED onto the archive row rather than joined at
// read time: by then the job order may have been revised, the customer renamed, the sales rep
// moved on and the artist left the company. A join would quietly rewrite what the archive says
// happened; a snapshot records what was true when the work was filed.
//
// source_kind + source_id still point at the live record, so the archive can link back to it --
// that is navigation, which is allowed to go stale. The six fields the artist sees are not.
//
// Kind and id rather than two nullable foreign keys because job orders and non-standard job
// orders are separate tables with separate numbering, and this is the same shape audit_logs
// already uses for auditable_type/auditable_id.
//
//   node src/db/add-archiver-artist-files.js --dry-run
//   node src/db/add-archiver-artist-files.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const COLUMNS = [
  ['archive_files', 'source_kind', "VARCHAR(10) NULL AFTER reference_no"],
  ['archive_files', 'source_id', 'BIGINT NULL AFTER source_kind'],
  // The frozen snapshot. Everything below is what the artist saw when they filed the work.
  ['archive_files', 'jo_no', 'VARCHAR(60) NULL AFTER source_id'],
  ['archive_files', 'jo_date', 'DATE NULL AFTER jo_no'],
  ['archive_files', 'customer_name', 'VARCHAR(255) NULL AFTER jo_date'],
  ['archive_files', 'sales_rep_name', 'VARCHAR(255) NULL AFTER customer_name'],
  ['archive_files', 'artist_name', 'VARCHAR(255) NULL AFTER sales_rep_name'],
  ['archive_files', 'layout_job_type', 'VARCHAR(200) NULL AFTER artist_name'],
  // Matches job_orders.description / non_standard_job_orders.description exactly, so a snapshot
  // can never be a truncated version of what the job order actually said.
  ['archive_files', 'job_description', 'VARCHAR(500) NULL AFTER layout_job_type'],
  // Kept as an id as well as a name, because "show me everything I archived" has to survive the
  // artist being renamed, and matching on a display name would not.
  ['archive_files', 'artist_employee_id', 'BIGINT NULL AFTER layout_job_type'],
];

const INDEXES = [
  ['archive_files', 'idx_archive_files_source', '(source_kind, source_id)'],
  ['archive_files', 'idx_archive_files_jo_no', '(jo_no)'],
  ['archive_files', 'idx_archive_files_artist', '(artist_employee_id)'],
];

const FOLDER = ['Artist Layout Files', 'Working files archived by artists against a job order'];

async function tableExists(name) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return rows.length > 0;
}
async function columnExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}
async function indexExists(table, name) {
  const [rows] = await pool.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name]);
  return rows.length > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  if (!(await tableExists('archive_files'))) {
    console.error('archive_files does not exist. Run src/db/create-archiver-files.js first.');
    process.exit(1);
  }

  for (const [table, column, definition] of COLUMNS) {
    if (await columnExists(table, column)) console.log(`Column ${table}.${column} already exists.`);
    else if (DRY_RUN) console.log(`Would add column ${table}.${column}.`);
    else { await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`); console.log(`Added column ${table}.${column}.`); }
  }

  for (const [table, name, cols] of INDEXES) {
    if (await indexExists(table, name)) console.log(`Index ${table}.${name} already exists.`);
    else if (DRY_RUN) console.log(`Would add index ${table}.${name}.`);
    else { await pool.query(`ALTER TABLE \`${table}\` ADD INDEX \`${name}\` ${cols}`); console.log(`Added index ${table}.${name}.`); }
  }

  console.log('');
  const [[found]] = await pool.query('SELECT id FROM archive_file_folders WHERE name = ?', [FOLDER[0]]);
  if (found) console.log(`Folder "${FOLDER[0]}" already exists (id ${found.id}).`);
  else if (DRY_RUN) console.log(`Would seed folder "${FOLDER[0]}".`);
  else {
    const [r] = await pool.query('INSERT INTO archive_file_folders (name, description) VALUES (?, ?)', FOLDER);
    console.log(`Seeded folder "${FOLDER[0]}" (id ${r.insertId}).`);
  }

  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
