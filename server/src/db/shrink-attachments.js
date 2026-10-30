// Shrinks the attachments already stored in the database (asked 2026-10-30), with the same rules
// new uploads now follow -- see lib/shrinkFile.js:
//
//   JPG / JPEG / PNG  -> JPG, max 2400 px, quality 82          (always)
//   PDF               -> PDF re-written at 300 dpi              (--pdf, needs Ghostscript)
//   EPS               -> PDF, still vector                      (--eps, needs Ghostscript)
//
// A file is replaced only when the result is at least 15% smaller. RAR / ZIP / AI / Office files
// are left alone, and so is the Archiver (archive_file_versions): its files carry a checksum as
// proof they were never altered.
//
// Tables: job_order_attachments and form_request_attachments.
//
//   node src/db/shrink-attachments.js [--pdf] [--eps] [--limit=N]          preview, changes nothing
//   node src/db/shrink-attachments.js [--pdf] [--eps] --apply              converts
//   node src/db/shrink-attachments.js --rollback=<originals dir>           puts every original back
//
// Before a row is overwritten its original is written to --originals=<dir> (default
// /root/attachment-originals-<timestamp>), with a manifest.jsonl -- that folder is what
// --rollback reads. It is outside /root/backups, so the nightly backup does not carry it; delete
// it once the converted files have been checked.
//
// Droplet, office and SM replicate: run on ONE box (the droplet). Ghostscript: apt-get install -y ghostscript
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { shrinkFile, ghostscript, hasSharp } = require('../lib/shrinkFile');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const APPLY = process.argv.includes('--apply');
const OPTS = { pdf: process.argv.includes('--pdf'), eps: process.argv.includes('--eps') };
const LIMIT = Number(arg('limit')) || 0;
const ROLLBACK = arg('rollback');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const ORIGINALS = arg('originals') || (process.platform === 'win32'
  ? path.join(__dirname, '..', '..', `attachment-originals-${STAMP}`) : `/root/attachment-originals-${STAMP}`);
const TABLES = ['job_order_attachments', 'form_request_attachments'];
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function quietBinlog() {
  // Only the new file needs to reach the replicas, not the old one as well.
  await pool.query("SET SESSION binlog_row_image = 'MINIMAL'").catch(() => {});
}

async function rollback() {
  const manifest = path.join(ROLLBACK, 'manifest.jsonl');
  const lines = fs.readFileSync(manifest, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  console.log(`Restoring ${lines.length} originals from ${ROLLBACK}`);
  await quietBinlog();
  let n = 0;
  for (const m of lines) {
    if (!TABLES.includes(m.table)) continue;
    const buf = fs.readFileSync(path.join(ROLLBACK, m.file));
    const [r] = await pool.query(`UPDATE ${m.table} SET file_name = ?, mime_type = ?, size_bytes = ?, file_data = ? WHERE id = ?`,
      [m.file_name, m.mime_type, buf.length, buf, m.id]);
    n += r.affectedRows;
  }
  console.log(`Restored ${n}.`);
}

async function run() {
  if (!hasSharp()) throw new Error('sharp is not installed -- run the deploy (npm install) first.');
  if ((OPTS.pdf || OPTS.eps) && !ghostscript()) throw new Error('Ghostscript is not installed: apt-get install -y ghostscript');
  const exts = ['jpg', 'jpeg', 'png', ...(OPTS.pdf ? ['pdf'] : []), ...(OPTS.eps ? ['eps'] : [])];
  console.log(`${APPLY ? 'APPLYING' : 'PREVIEW'} -- ${exts.join(', ')}${LIMIT ? `, first ${LIMIT}` : ''}`);
  if (APPLY) { fs.mkdirSync(ORIGINALS, { recursive: true }); await quietBinlog(); }
  const manifest = APPLY ? fs.createWriteStream(path.join(ORIGINALS, 'manifest.jsonl'), { flags: 'a' }) : null;

  const total = { files: 0, changed: 0, before: 0, after: 0 };
  for (const table of TABLES) {
    const [ids] = await pool.query(
      `SELECT id FROM ${table} WHERE file_data IS NOT NULL
          AND LOWER(SUBSTRING_INDEX(file_name, '.', -1)) IN (?) ORDER BY id${LIMIT ? ` LIMIT ${LIMIT}` : ''}`, [exts]);
    const t = { files: ids.length, changed: 0, before: 0, after: 0 };
    for (const { id } of ids) {
      // One row at a time: the table holds gigabytes.
      const [[row]] = await pool.query(`SELECT id, file_name, mime_type, file_data FROM ${table} WHERE id = ?`, [id]);
      if (!row) continue;
      const out = await shrinkFile(row.file_data, row.file_name, OPTS);
      if (!out) continue;
      t.changed += 1; t.before += row.file_data.length; t.after += out.buf.length;
      if (!APPLY) {
        if (t.changed <= 15) console.log(`  ${table} #${id} ${row.file_name} ${mb(row.file_data.length)} -> ${out.fileName} ${mb(out.buf.length)}`);
        continue;
      }
      const file = `${table}-${id}`;
      fs.writeFileSync(path.join(ORIGINALS, file), row.file_data);
      manifest.write(`${JSON.stringify({ table, id, file, file_name: row.file_name, mime_type: row.mime_type })}\n`);
      await pool.query(`UPDATE ${table} SET file_name = ?, mime_type = ?, size_bytes = ?, file_data = ? WHERE id = ?`,
        [out.fileName.slice(0, 255), out.mime, out.buf.length, out.buf, id]);
      if (t.changed % 50 === 0) console.log(`  ${table}: ${t.changed} converted, ${mb(t.before - t.after)} saved so far`);
    }
    console.log(`${table}: ${t.files} files looked at, ${t.changed} ${APPLY ? 'converted' : 'would convert'}: ${mb(t.before)} -> ${mb(t.after)} (saves ${mb(t.before - t.after)})`);
    for (const k of Object.keys(total)) total[k] += t[k];
  }
  console.log(`\nTOTAL: ${total.changed} of ${total.files} files, ${mb(total.before)} -> ${mb(total.after)}, saves ${mb(total.before - total.after)}`);
  if (manifest) { await new Promise((r) => manifest.end(r)); console.log(`Originals kept in ${ORIGINALS}  (undo: --rollback=${ORIGINALS})`); }
  if (!APPLY) console.log('Preview only. Re-run with --apply to convert.');
}

(ROLLBACK ? rollback() : run())
  .then(() => pool.end())
  .catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
