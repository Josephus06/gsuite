// One-off migration: Archiver > Files -- a shared store for the documents a company has to be
// able to find years later. Contracts, official receipts, BIR filings, warranty certificates,
// licence PDFs, signed agreements.
//
// Stored as LONGBLOB in the database, the same way hrd_room_files and every *_attachments table
// in this app already do it. That is not the choice a greenfield system would make -- object
// storage would be -- but consistency wins here for two concrete reasons: the existing backup and
// replication story already covers the database and would not cover a disk directory, and the
// office box is meant to keep working when the internet does not, which rules out anything
// remote. See the size cap note below.
//
// Files are NOT encrypted at rest, unlike stored credentials. A password is a secret whose whole
// value is that nobody sees it; a contract is a document people are meant to read, and encrypting
// megabytes of PDF per request would cost real time for protection the access rules already give.
// If a particular document IS a secret, the credential vault next door is the right place for it,
// and the UI says so.
//
//   node src/db/create-archiver-files.js --dry-run
//   node src/db/create-archiver-files.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const TABLES = [
  ['archive_file_folders', `
CREATE TABLE archive_file_folders (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    description VARCHAR(500) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uq_archive_file_folders_name (name)
)`],

  // The document's record. Deliberately separate from the bytes: every list, search and permission
  // check reads this table, and none of them should drag a 10MB blob along to decide whether to
  // show a filename.
  ['archive_files', `
CREATE TABLE archive_files (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    file_no VARCHAR(40) UNIQUE NOT NULL,
    title VARCHAR(200) NOT NULL,
    folder_id BIGINT NULL,
    description VARCHAR(2000) NULL,
    reference_no VARCHAR(200) NULL,
    document_date DATE NULL,
    expires_on DATE NULL,
    owner_user_id BIGINT NULL,
    department_id BIGINT NULL,
    visibility VARCHAR(20) NOT NULL DEFAULT 'shared',
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    current_version INT NOT NULL DEFAULT 0,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by_user_id BIGINT NULL,
    updated_at DATETIME NULL,
    INDEX idx_archive_files_folder (folder_id),
    INDEX idx_archive_files_owner (owner_user_id),
    INDEX idx_archive_files_status (status),
    INDEX idx_archive_files_expires (expires_on)
)`],

  // Versions, because the reason to keep a contract is to be able to prove what it said. Replacing
  // the bytes in place would destroy exactly the thing being archived, so an upload adds a version
  // and the old one stays readable.
  ['archive_file_versions', `
CREATE TABLE archive_file_versions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    file_id BIGINT NOT NULL,
    version_no INT NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes INT NOT NULL,
    checksum_sha256 CHAR(64) NULL,
    file_data LONGBLOB NOT NULL,
    note VARCHAR(500) NULL,
    uploaded_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_archive_file_version (file_id, version_no),
    INDEX idx_archive_file_versions_file (file_id)
)`],

  // Same per-entry sharing as the credential vault, so the two modules behave alike rather than
  // each inventing its own rules.
  ['archive_file_shares', `
CREATE TABLE archive_file_shares (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    file_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    can_edit BOOLEAN NOT NULL DEFAULT FALSE,
    granted_by_user_id BIGINT NULL,
    granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_archive_file_share (file_id, user_id),
    INDEX idx_archive_file_shares_user (user_id)
)`],

  // Downloads are logged. Not because a document is a password, but because "who took a copy of
  // the signed contract, and when" is a question that gets asked, and nothing else can answer it.
  ['archive_file_logs', `
CREATE TABLE archive_file_logs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    file_id BIGINT NULL,
    version_id BIGINT NULL,
    user_id BIGINT NULL,
    action VARCHAR(40) NOT NULL,
    detail VARCHAR(500) NULL,
    ip_address VARCHAR(64) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_archive_file_logs_file (file_id, created_at),
    INDEX idx_archive_file_logs_user (user_id, created_at)
)`],
];

const SEED_FOLDERS = [
  ['Contracts & Agreements', 'Signed contracts, MOAs and service agreements'],
  ['Government & Compliance', 'BIR, SEC, DTI, LGU permits and filings'],
  ['Licences & Certificates', 'Software licences, warranties and certifications'],
  ['Invoices & Receipts', 'Official receipts and supplier invoices worth keeping'],
  ['Insurance', 'Policies and claims'],
  ['Property & Leases', 'Titles, lease agreements and property papers'],
  ['Manuals & Documentation', 'Equipment manuals and internal documentation'],
  ['HR & Personnel', 'Company-level HR documents'],
  ['Other', 'Anything that does not fit the folders above'],
];

async function tableExists(name) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return rows.length > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  for (const [name, ddl] of TABLES) {
    if (await tableExists(name)) console.log(`Table ${name} already exists.`);
    else if (DRY_RUN) console.log(`Would create table ${name}.`);
    else { await pool.query(ddl); console.log(`Created table ${name}.`); }
  }

  console.log('');
  if (await tableExists('archive_file_folders')) {
    for (const [name, description] of SEED_FOLDERS) {
      const [[found]] = await pool.query('SELECT id FROM archive_file_folders WHERE name = ?', [name]);
      if (found) { console.log(`  ok    ${name}`); continue; }
      if (DRY_RUN) { console.log(`  +     would seed ${name}`); continue; }
      await pool.query('INSERT INTO archive_file_folders (name, description) VALUES (?, ?)', [name, description]);
      console.log(`  +     ${name}`);
    }
  } else if (DRY_RUN) {
    console.log(`  ~ would seed ${SEED_FOLDERS.length} folders.`);
  }

  // max_allowed_packet is the real ceiling on a LONGBLOB written in one statement, and it is a
  // server setting rather than anything the app controls. Worth reporting, because the failure
  // when a file exceeds it is an opaque packet error at upload time rather than a clear message.
  try {
    const [[v]] = await pool.query("SHOW VARIABLES LIKE 'max_allowed_packet'");
    const mb = Math.round(Number(v.Value) / 1024 / 1024);
    console.log(`\nmax_allowed_packet on this server: ${mb} MB.`);
    console.log('The app caps uploads at 25 MB per file; raise the server setting if that ever changes.');
  } catch { /* not fatal, only informational */ }

  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
