// Lets an archive file version live in object storage instead of the database.
//
// Layout archives for large-format work run to tens of gigabytes, and three separate walls make
// the database impossible for those: a MySQL LONGBLOB tops out at 4 GB, the droplet has ~55 GB of
// free disk, and droplet/office replication would ship every byte between them. None of those is
// a setting that can be raised.
//
// So a version is now stored ONE of two ways, and `storage` says which:
//
//   'db'      file_data holds the bytes, as before. Small documents -- contracts, permits,
//             receipts -- stay here deliberately, because the office box has to keep working when
//             the internet is down and a database row does that while object storage does not.
//   'spaces'  the bytes are in S3-compatible storage and storage_key points at them. file_data is
//             NULL. Used for anything too big for the in-database path.
//
// file_data becomes NULLABLE for the second case. Existing rows are untouched and keep working:
// the backfill below stamps them 'db', which is what they are.
//
// upload_status tracks a multipart upload in flight. An archive is not visible as a usable file
// until it reads 'complete' -- a 150 GB upload takes hours and can fail halfway, and a half-
// uploaded object that looks like an archive is worse than no archive.
//
//   node src/db/add-archiver-object-storage.js --dry-run
//   node src/db/add-archiver-object-storage.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const COLUMNS = [
  ['archive_file_versions', 'storage', "VARCHAR(10) NOT NULL DEFAULT 'db' AFTER version_no"],
  ['archive_file_versions', 'storage_key', 'VARCHAR(500) NULL AFTER storage'],
  ['archive_file_versions', 'storage_bucket', 'VARCHAR(150) NULL AFTER storage_key'],
  ['archive_file_versions', 'storage_etag', 'VARCHAR(120) NULL AFTER storage_bucket'],
  ['archive_file_versions', 'upload_id', 'VARCHAR(500) NULL AFTER storage_etag'],
  ['archive_file_versions', 'upload_status', "VARCHAR(20) NOT NULL DEFAULT 'complete' AFTER upload_id"],
  ['archive_file_versions', 'upload_started_at', 'DATETIME NULL AFTER upload_status'],
  // BIGINT, not INT: size_bytes was INT, which caps at 2,147,483,647 -- about 2 GB. A 150 GB file
  // would have silently overflowed it, and the archive would have reported a nonsense size.
  ['archive_file_versions', 'size_bytes_large', 'BIGINT NULL AFTER size_bytes'],
];

const INDEXES = [
  ['archive_file_versions', 'idx_afv_upload_status', '(upload_status)'],
  ['archive_file_versions', 'idx_afv_storage_key', '(storage_key(191))'],
];

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

  if (!(await tableExists('archive_file_versions'))) {
    console.error('archive_file_versions does not exist. Run src/db/create-archiver-files.js first.');
    process.exit(1);
  }

  for (const [table, column, definition] of COLUMNS) {
    if (await columnExists(table, column)) console.log(`Column ${table}.${column} already exists.`);
    else if (DRY_RUN) console.log(`Would add column ${table}.${column}.`);
    else { await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`); console.log(`Added column ${table}.${column}.`); }
  }

  // file_data must accept NULL for a version whose bytes live in storage. Widened rather than
  // replaced, so every existing row keeps its contents.
  const [[fd]] = await pool.query("SHOW COLUMNS FROM archive_file_versions LIKE 'file_data'");
  if (fd && fd.Null === 'YES') console.log('Column archive_file_versions.file_data is already nullable.');
  else if (DRY_RUN) console.log('Would make archive_file_versions.file_data nullable.');
  else {
    await pool.query('ALTER TABLE archive_file_versions MODIFY COLUMN file_data LONGBLOB NULL');
    console.log('Made archive_file_versions.file_data nullable.');
  }

  for (const [table, name, cols] of INDEXES) {
    if (await indexExists(table, name)) console.log(`Index ${table}.${name} already exists.`);
    else if (DRY_RUN) console.log(`Would add index ${table}.${name}.`);
    else { await pool.query(`ALTER TABLE \`${table}\` ADD INDEX \`${name}\` ${cols}`); console.log(`Added index ${table}.${name}.`); }
  }

  // Existing rows are all in-database and complete. Stamped explicitly rather than relying on the
  // column defaults, so a row written before this migration and one written after are
  // indistinguishable afterwards.
  if (!DRY_RUN && await columnExists('archive_file_versions', 'size_bytes_large')) {
    const [r] = await pool.query(
      "UPDATE archive_file_versions SET storage = 'db', upload_status = 'complete', size_bytes_large = size_bytes WHERE size_bytes_large IS NULL",
    );
    console.log(`\nBackfilled ${r.affectedRows} existing version row(s) as in-database and complete.`);
  }

  console.log('\n--- Object storage settings ---');
  const need = ['SPACES_ENDPOINT', 'SPACES_BUCKET', 'SPACES_KEY', 'SPACES_SECRET'];
  const missing = need.filter((k) => !process.env[k]);
  if (!missing.length) {
    console.log(`Configured. Bucket: ${process.env.SPACES_BUCKET} at ${process.env.SPACES_ENDPOINT}`);
  } else {
    console.log(`NOT configured -- missing ${missing.join(', ')}.`);
    console.log('Until these are set, large uploads are refused with a clear message and the');
    console.log('in-database path for small documents keeps working. Example for DigitalOcean:');
    console.log('');
    console.log('  SPACES_ENDPOINT=https://sgp1.digitaloceanspaces.com');
    console.log('  SPACES_REGION=sgp1');
    console.log('  SPACES_BUCKET=graphicstar-archive');
    console.log('  SPACES_KEY=<access key>');
    console.log('  SPACES_SECRET=<secret>');
    console.log('');
    console.log('The SAME bucket and keys on droplet, office and Railway -- they share one');
    console.log('archive, and a per-install bucket would hide files from whoever is on the other.');
  }

  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
