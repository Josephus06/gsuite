// Attachment archive (asked 2026-11-04, lib/localArchive.js and db/archive-attachments.js): every
// attachment table gets where its file went once moved to the office archive drive --
//   archive_path    relative to ARCHIVE_DIR on the office server (NULL = still in the database / Spaces)
//   archive_sha256  checksum of the archived copy, checked when it was written
//   archived_at     when it was moved (UTC)
// Added INSTANT (no table rebuild), so it is quick even on job_order_attachments' 3 GB.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-attachment-archive-columns.js
require('dotenv').config();
const pool = require('../db');

const TABLES = [
  'job_order_attachments', 'sales_order_attachments', 'estimate_attachments', 'ticket_attachments',
  'form_request_attachments', 'document_attachments', 'archive_file_versions',
];
const COLUMNS = [
  ['archive_path', 'VARCHAR(500) NULL'],
  ['archive_sha256', 'CHAR(64) NULL'],
  ['archived_at', 'DATETIME NULL'],
];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const t of TABLES) {
    const [[exists]] = await pool.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]);
    if (!exists.n) { console.log(`  ${t}: no such table here -- skipped`); continue; }
    const [cols] = await pool.query(`SHOW COLUMNS FROM ${t}`);
    const have = new Set(cols.map((c) => c.Field));
    const add = COLUMNS.filter(([c]) => !have.has(c));
    if (!add.length) { console.log(`  ${t}: already has the archive columns`); continue; }
    const sql = `ALTER TABLE ${t} ${add.map(([c, def]) => `ADD COLUMN ${c} ${def}`).join(', ')}`;
    try { await pool.query(`${sql}, ALGORITHM=INSTANT`); }
    catch { await pool.query(sql); } // an older table format that cannot add instantly
    console.log(`  ${t}: added ${add.map(([c]) => c).join(', ')}`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
