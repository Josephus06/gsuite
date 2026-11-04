// Moves attachments off the cloud onto the office server's archive drive (asked 2026-11-04).
//
// RUNS ON THE OFFICE SERVER, as root, from /opt/gsuite/server. On the 1st of each month (cron) it
// takes everything uploaded before that month and, file by file:
//   1. writes it under ARCHIVE_DIR (/backup/archive), in folders a person can browse:
//        job-orders/2026/10/JO-203521-1-4/1234_layout.pdf
//        archiver-files/2026/10/NSTDJO-15141/882_MANULIFE VARIOUS MERCH.rar
//   2. reads the copy back and checks its SHA-256 against the bytes it came from;
//   3. only then empties the source: the row's file_data (database files -- read from the office's
//      own replicated copy, nothing crosses the internet) or the DigitalOcean Spaces object (large
//      Archiver files -- downloaded once), and records archive_path / archive_sha256 / archived_at.
// The row change replicates, so cloud and SM serve the file from the office from then on
// (lib/localArchive.js) and their copies of the bytes are gone too.
//
// Tables: Job Order, Sales Order, Estimate, Ticket, Form Request and Customer Payment / Sales
// Invoice attachments, and Archiver > Files (in-database and Spaces). Not chat, HRD rooms, the
// knowledge base, photos, signatures or dashboard media.
//
// THE ARCHIVE DRIVE BECOMES THE ONLY COPY. Back it up.
//
//   node src/db/archive-attachments.js                   dry run: what would move, by table and month
//   node src/db/archive-attachments.js --apply           move it
//     --before=YYYY-MM   move what was uploaded before the 1st of that month (Manila). Default: this month.
//     --only=jo,so,estimate,ticket,form,document,archiver,spaces   some sources only
//     --limit=N          stop after N files (a first trial run)
//     --keep-spaces      copy Spaces files but leave them in Spaces as well
//     --no-optimize      skip OPTIMIZE TABLE afterwards (it gives the freed space back to the disk)
//   node src/db/archive-attachments.js --check            every archived file still on the drive, size right
//   node src/db/archive-attachments.js --check --deep     ... and its checksum right (reads everything)
//
// Needs in server/.env: ARCHIVE_DIR=/backup/archive, and the SPACES_* settings for the Spaces files.
// ARCHIVE_RESERVE_GB (default 30) is left free on the drive -- the MySQL backups live there too.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const pool = require('../db');
const storage = require('../lib/objectStorage');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const APPLY = flag('apply');
const CHECK = flag('check');
const LIMIT = Number(opt('limit')) || Infinity;
const ONLY = opt('only') ? new Set(opt('only').split(',').map((s) => s.trim())) : null;
const ROOT = process.env.ARCHIVE_DIR || '';
const RESERVE = (Number(process.env.ARCHIVE_RESERVE_GB) || 30) * 1024 ** 3;

const log = (...m) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...m);
const gb = (b) => `${(Number(b || 0) / 1024 ** 3).toFixed(2)} GB`;

// The first instant of a Manila month, as the UTC DATETIME the database stores.
function cutoffUtc(ym) {
  return new Date(`${ym}-01T00:00:00+08:00`).toISOString().slice(0, 19).replace('T', ' ');
}
const manilaMonth = (utc) => new Date(new Date(`${String(utc).replace(' ', 'T')}Z`).getTime() + 8 * 3600e3).toISOString().slice(0, 7);
const thisMonth = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);

// Every source of files. kind 'db' = bytes in file_data, 'spaces' = bytes in object storage.
const SOURCES = [
  { key: 'jo', table: 'job_order_attachments', kind: 'db', folder: "'job-orders'", doc: '(SELECT job_order_no FROM job_orders WHERE id = a.job_order_id)' },
  { key: 'so', table: 'sales_order_attachments', kind: 'db', folder: "'sales-orders'", doc: '(SELECT sales_order_no FROM sales_orders WHERE id = a.sales_order_id)' },
  { key: 'estimate', table: 'estimate_attachments', kind: 'db', folder: "'estimates'", doc: '(SELECT estimate_no FROM estimates WHERE id = a.estimate_id)' },
  { key: 'ticket', table: 'ticket_attachments', kind: 'db', folder: "'tickets'", doc: '(SELECT ticket_no FROM tickets WHERE id = a.ticket_id)' },
  { key: 'form', table: 'form_request_attachments', kind: 'db', folder: "'form-requests'", doc: '(SELECT request_no FROM form_requests WHERE id = a.form_request_id)' },
  {
    key: 'document', table: 'document_attachments', kind: 'db',
    folder: "CASE a.doc_type WHEN 'customer_payment' THEN 'customer-payments' WHEN 'sales_invoice' THEN 'sales-invoices' ELSE 'documents' END",
    doc: `CASE a.doc_type WHEN 'customer_payment' THEN (SELECT customer_payment_no FROM customer_payments WHERE id = a.doc_id)
                         WHEN 'sales_invoice' THEN (SELECT invoice_no FROM sales_invoices WHERE id = a.doc_id) END`,
  },
  {
    key: 'archiver', table: 'archive_file_versions', kind: 'db', where: "a.storage = 'db'", folder: "'archiver-files'",
    doc: "(SELECT COALESCE(NULLIF(f.jo_no, ''), f.file_no) FROM archive_files f WHERE f.id = a.file_id)",
  },
  {
    key: 'spaces', table: 'archive_file_versions', kind: 'spaces', where: "a.storage = 'spaces' AND a.upload_status = 'complete' AND a.storage_key IS NOT NULL",
    folder: "'archiver-files'", doc: "(SELECT COALESCE(NULLIF(f.jo_no, ''), f.file_no) FROM archive_files f WHERE f.id = a.file_id)",
  },
].filter((s) => !ONLY || ONLY.has(s.key));

const sizeCol = (s) => (s.table === 'archive_file_versions' ? 'COALESCE(a.size_bytes_large, a.size_bytes)' : 'a.size_bytes');
const pending = (s) => `a.archive_path IS NULL AND a.created_at < ?${s.where ? ` AND ${s.where}` : ''}`;

// A name that is safe as a folder or file on any OS, its extension kept.
function safe(name, max = 150) {
  let n = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (!n) n = 'unknown';
  if (n.length > max) { const ext = path.extname(n).slice(0, 12); n = n.slice(0, max - ext.length) + ext; }
  return n;
}

async function hashFile(full) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(full), h);
  return h.digest('hex');
}
function fsyncFile(full) { const fd = fs.openSync(full, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function freeBytes() { const s = fs.statfsSync(ROOT); return Number(s.bavail) * Number(s.bsize); }

// One file per manifest line, a month's file per run month -- what was moved where, readable
// without the database.
function manifest(rec) {
  const dir = path.join(ROOT, '_manifest');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${thisMonth()}.csv`);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'archived_at,table,id,document,bytes,sha256,path\n');
  fs.appendFileSync(file, [new Date().toISOString(), rec.table, rec.id, rec.doc, rec.bytes, rec.sha, rec.rel].map(q).join(',') + '\n');
}

async function dryRun(conn, cutoff) {
  log(`DRY RUN -- nothing is changed. Uploaded before ${cutoff} UTC.`);
  let total = 0; let files = 0;
  for (const s of SOURCES) {
    const [rows] = await conn.query(
      `SELECT DATE_FORMAT(a.created_at + INTERVAL 8 HOUR, '%Y-%m') AS month, COUNT(*) AS n, SUM(${sizeCol(s)}) AS bytes
         FROM ${s.table} a WHERE ${pending(s)} GROUP BY month ORDER BY month`, [cutoff]);
    for (const r of rows) {
      log(`  ${s.key.padEnd(9)} ${s.table.padEnd(26)} ${r.month}  ${String(r.n).padStart(6)} files  ${gb(r.bytes).padStart(10)}`);
      total += Number(r.bytes || 0); files += Number(r.n);
    }
  }
  log(`  total ${files} files, ${gb(total)}. Free on ${ROOT}: ${gb(freeBytes())} (keeping ${gb(RESERVE)} free).`);
  if (total > freeBytes() - RESERVE) log('  NOT ENOUGH ROOM for all of it: --apply would stop when the drive reaches the reserve.');
  log('Run again with --apply to move it.');
}

// Writes buf (database files) or the Spaces object to dest, checks it, returns its sha256.
async function writeCopy(s, row, full) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const part = `${full}.part`;
  let sha; let bytes;
  if (s.kind === 'db') {
    const [[b]] = await row.conn.query(`SELECT file_data FROM ${s.table} WHERE id = ?`, [row.id]);
    const buf = b?.file_data;
    if (!buf || !buf.length) return { skip: 'no bytes stored' };
    fs.writeFileSync(part, buf);
    sha = crypto.createHash('sha256').update(buf).digest('hex');
    bytes = buf.length;
  } else {
    const head = await storage.headObject(row.storage_key);
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(await storage.signDownload(row.storage_key, row.file_name));
        if (!res.ok || !res.body) throw new Error(`Spaces answered ${res.status}`);
        const h = crypto.createHash('sha256'); let n = 0;
        const tap = new Transform({ transform(chunk, _e, cb) { h.update(chunk); n += chunk.length; cb(null, chunk); } });
        await pipeline(Readable.fromWeb(res.body), tap, fs.createWriteStream(part));
        sha = h.digest('hex'); bytes = n; last = null;
        break;
      } catch (e) { last = e; log(`    download attempt ${attempt} failed: ${e.message}`); }
    }
    if (last) throw last;
    if (bytes !== head.size) throw new Error(`downloaded ${bytes} bytes, Spaces says ${head.size}`);
  }
  if (row.checksum_sha256 && row.checksum_sha256 !== sha) {
    if (s.kind === 'spaces') throw new Error(`checksum differs from the one recorded at upload (${row.checksum_sha256.slice(0, 12)}...)`);
    log(`    note: bytes differ from the checksum recorded at upload; archived as stored`);
  }
  fsyncFile(part);
  fs.renameSync(part, full);
  const back = await hashFile(full);
  if (back !== sha) { fs.unlinkSync(full); throw new Error('the copy read back differently -- drive problem? left in place'); }
  return { sha, bytes };
}

async function apply(conn, cutoff) {
  log(`APPLY -- moving files uploaded before ${cutoff} UTC to ${ROOT}`);
  // The row changes below would otherwise put each file's full bytes in the binary log once more
  // (the before-image) -- 150 GB of log for a month of layouts. MINIMAL logs only the key.
  try { await conn.query("SET SESSION binlog_row_image = 'MINIMAL'"); log('  binlog_row_image MINIMAL for this run'); }
  catch (e) { log(`  could not set binlog_row_image MINIMAL (${e.message.split('\n')[0]}): the binary log grows by the files moved until it expires`); }

  const nullable = {};
  const optimize = new Set();
  let moved = 0; let movedBytes = 0; let failed = 0; let done = 0;
  outer: for (const s of SOURCES) {
    if (s.kind === 'spaces' && !storage.isConfigured()) { log(`  ${s.key}: SPACES_* not set in .env -- skipped`); continue; }
    if (nullable[s.table] === undefined) {
      const [[c]] = await conn.query(`SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'file_data'`, [s.table]);
      nullable[s.table] = c?.IS_NULLABLE === 'YES';
    }
    const [rows] = await conn.query(
      `SELECT a.id, a.file_name, a.created_at, ${sizeCol(s)} AS size, ${s.folder} AS folder, ${s.doc} AS doc
              ${s.table === 'archive_file_versions' ? ', a.storage_key, a.checksum_sha256' : ''}
         FROM ${s.table} a WHERE ${pending(s)} ORDER BY a.id`, [cutoff]);
    log(`  ${s.key}: ${rows.length} file(s), ${gb(rows.reduce((n, r) => n + Number(r.size || 0), 0))}`);
    for (const r of rows) {
      if (done >= LIMIT) { log(`  --limit ${LIMIT} reached`); break outer; }
      if (freeBytes() - Number(r.size || 0) < RESERVE) { log(`  STOPPED: ${ROOT} is down to ${gb(freeBytes())}, the reserve is ${gb(RESERVE)}. Free space or add a drive, then run again.`); break outer; }
      const month = manilaMonth(r.created_at);
      const rel = [r.folder, month.slice(0, 4), month.slice(5, 7), safe(r.doc || 'no-document', 80), safe(`${r.id}_${r.file_name}`)].join('/');
      const full = path.join(ROOT, rel);
      done++;
      try {
        let out;
        if (fs.existsSync(full)) out = { sha: await hashFile(full), bytes: fs.statSync(full).size, reused: true }; // an earlier run stopped after copying
        else out = await writeCopy(s, { ...r, conn }, full);
        if (out.skip) { log(`    skip ${s.table} #${r.id}: ${out.skip}`); continue; }
        if (out.reused && s.kind === 'spaces' && out.bytes !== (await storage.headObject(r.storage_key)).size) {
          fs.unlinkSync(full); throw new Error('an incomplete copy from an earlier run was removed; it is copied again next run');
        }
        const extra = s.table === 'archive_file_versions' ? ", storage = 'local'" : '';
        const empty = s.kind === 'db' ? `, file_data = ${nullable[s.table] ? 'NULL' : "''"}` : '';
        const [u] = await conn.query(
          `UPDATE ${s.table} SET archive_path = ?, archive_sha256 = ?, archived_at = UTC_TIMESTAMP()${empty}${extra}
            WHERE id = ? AND archive_path IS NULL`, [rel, out.sha, r.id]);
        if (!u.affectedRows) { log(`    ${s.table} #${r.id} changed meanwhile -- left as it is`); continue; }
        if (s.kind === 'db') optimize.add(s.table);
        if (s.kind === 'spaces' && !flag('keep-spaces')) {
          await storage.deleteObject(r.storage_key);
          await conn.query('UPDATE archive_file_versions SET storage_key = NULL WHERE id = ?', [r.id]);
        }
        manifest({ table: s.table, id: r.id, doc: r.doc, bytes: out.bytes, sha: out.sha, rel });
        moved++; movedBytes += out.bytes;
        log(`    ok ${rel} (${gb(out.bytes)})`);
      } catch (e) {
        failed++;
        try { fs.rmSync(`${full}.part`, { force: true }); } catch { /* nothing left behind */ }
        log(`    FAILED ${s.table} #${r.id} ${r.file_name}: ${e.message} -- left where it was`);
      }
    }
  }

  // Spaces objects left by an earlier --keep-spaces run, or a delete that failed.
  if (!flag('keep-spaces') && storage.isConfigured() && (!ONLY || ONLY.has('spaces'))) {
    const [left] = await conn.query("SELECT id, storage_key FROM archive_file_versions WHERE storage = 'local' AND storage_key IS NOT NULL");
    for (const r of left) {
      try { await storage.deleteObject(r.storage_key); await conn.query('UPDATE archive_file_versions SET storage_key = NULL WHERE id = ?', [r.id]); }
      catch (e) { log(`    could not delete Spaces object of #${r.id}: ${e.message}`); }
    }
    if (left.length) log(`  removed ${left.length} Spaces object(s) already archived`);
  }

  // InnoDB keeps the emptied space inside the table file; a rebuild hands it back to the disk. It
  // replicates, so the cloud and SM rebuild (and shrink) their copies too.
  if (optimize.size && !flag('no-optimize')) {
    for (const t of optimize) { log(`  OPTIMIZE TABLE ${t}`); await conn.query(`OPTIMIZE TABLE ${t}`); }
  }
  log(`DONE: ${moved} file(s), ${gb(movedBytes)} moved; ${failed} failed. Free on ${ROOT}: ${gb(freeBytes())}.`);
  return failed;
}

async function check(conn) {
  const deep = flag('deep');
  let ok = 0; let bad = 0;
  for (const t of [...new Set(SOURCES.map((s) => s.table))]) {
    const sz = t === 'archive_file_versions' ? 'COALESCE(size_bytes_large, size_bytes)' : 'size_bytes';
    const [rows] = await conn.query(`SELECT id, archive_path, archive_sha256, ${sz} AS size FROM ${t} WHERE archive_path IS NOT NULL`);
    for (const r of rows) {
      const full = path.join(ROOT, r.archive_path);
      let why = null;
      if (!fs.existsSync(full)) why = 'missing';
      else if (deep && (await hashFile(full)) !== r.archive_sha256) why = 'checksum differs';
      if (why) { bad++; log(`  ${why}: ${t} #${r.id} ${r.archive_path}`); } else ok++;
    }
  }
  log(`CHECK${deep ? ' (deep)' : ''}: ${ok} file(s) fine, ${bad} problem(s).`);
  return bad;
}

(async () => {
  if (!ROOT || !fs.existsSync(ROOT)) throw new Error(`ARCHIVE_DIR (${ROOT || 'not set'}) does not exist. Set it in server/.env (ARCHIVE_DIR=/backup/archive) and create the folder.`);
  fs.accessSync(ROOT, fs.constants.W_OK);
  const before = opt('before') || thisMonth();
  if (!/^\d{4}-\d{2}$/.test(before)) throw new Error('--before is YYYY-MM');
  const cutoff = cutoffUtc(before);
  log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}; archive ${ROOT}`);

  const conn = await pool.getConnection();
  // A table this database does not have (an older copy) is left out rather than failing the run.
  for (let i = SOURCES.length - 1; i >= 0; i--) {
    const [[t]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [SOURCES[i].table]);
    if (!t.n) { log(`  ${SOURCES[i].table}: no such table here -- skipped`); SOURCES.splice(i, 1); }
  }
  const [[col]] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_order_attachments' AND COLUMN_NAME = 'archive_path'");
  if (!col.n) throw new Error('The archive columns are missing: run node src/db/add-attachment-archive-columns.js (on the droplet) first.');

  // One run at a time: a monthly cron overlapping a hand-started run would copy the same files twice.
  const lock = path.join(ROOT, '.archive.lock');
  if (APPLY) {
    if (fs.existsSync(lock)) {
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      let alive = false; try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
      if (alive) throw new Error(`another archive run (pid ${pid}) is in progress`);
    }
    fs.writeFileSync(lock, String(process.pid));
  }
  let problems = 0;
  try {
    if (CHECK) problems = await check(conn);
    else if (APPLY) problems = await apply(conn, cutoff);
    else await dryRun(conn, cutoff);
  } finally {
    if (APPLY) fs.rmSync(lock, { force: true });
    conn.release();
    await pool.end();
  }
  process.exit(problems ? 2 : 0);
})().catch(async (e) => { console.error('Failed:', e.message); try { await pool.end(); } catch { /* closed */ } process.exit(1); });
