const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth, requirePermission, isSystemAdmin } = require('../middleware/auth');
const storage = require('../lib/objectStorage');

const router = express.Router();

// Archiver > Files: the documents a company must still be able to produce years later.
//
// Two rules shape the routes:
//
//   1. THE BYTES ARE NEVER READ UNLESS SOMEBODY IS DOWNLOADING THEM. Lists, detail views and
//      version history all read the metadata table only. A 10MB blob must not be dragged through
//      a query that exists to render a filename.
//
//   2. UPLOADING A NEW COPY ADDS A VERSION, IT DOES NOT REPLACE ONE. The reason to archive a
//      signed contract is to prove what it said; overwriting the bytes would destroy exactly what
//      was being kept.
//
// Sharing works the same way as the credential vault next door, deliberately -- two modules in
// one section inventing different access rules is how people end up guessing.
const ROUTE = '/archiver/files';

const MAX_BYTES = 25 * 1024 * 1024; // 25MB, matched by the body parser in index.js
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const STATUSES = new Set(['active', 'superseded', 'expired', 'archived']);

// Types people actually archive. An allow-list rather than a block-list: a store that accepts
// anything becomes a way to pass executables around, and nobody archives a .exe as a record.
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv',
  'application/zip', 'application/x-zip-compressed',
  'application/vnd.rar', 'application/x-rar-compressed',
]);

const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
const idOrNull = (v) => (v == null || v === '' ? null : v);

// Everything except file_data. Written out once so no query can widen into the blob by accident.
const FILE_COLUMNS = `f.id, f.file_no, f.title, f.folder_id, f.description, f.reference_no,
  f.document_date, f.expires_on, f.owner_user_id, f.department_id, f.visibility, f.status,
  f.current_version, f.created_by_user_id, f.created_at, f.updated_at,
  f.source_kind, f.source_id, f.jo_no, f.jo_date, f.customer_name, f.sales_rep_name,
  f.artist_name, f.layout_job_type, f.job_description, f.artist_employee_id`;

async function logFile(conn, req, { fileId, versionId = null, action, detail = null }) {
  await (conn || pool).query(
    'INSERT INTO archive_file_logs (file_id, version_id, user_id, action, detail, ip_address) VALUES (?,?,?,?,?,?)',
    [fileId || null, versionId, req.user?.id || null, action, trunc(detail, 500),
      trunc(req.ip || req.headers['x-forwarded-for'] || null, 64)],
  );
}

// What this user may do with one file.
//
// `visibility = 'company'` means everyone with the page may read it -- a company handbook has no
// business needing a share per employee. 'shared' means owner, System Admin and named shares only.
async function fileAccess(userId, fileId, conn) {
  const q = conn || pool;
  const [[file]] = await q.query('SELECT id, owner_user_id, visibility, title, file_no FROM archive_files WHERE id = ?', [fileId]);
  if (!file) return { found: false, canView: false, canEdit: false };

  if (await isSystemAdmin(userId)) return { found: true, file, canView: true, canEdit: true, via: 'system_admin' };
  if (String(file.owner_user_id) === String(userId)) return { found: true, file, canView: true, canEdit: true, via: 'owner' };

  const [[share]] = await q.query('SELECT can_edit FROM archive_file_shares WHERE file_id = ? AND user_id = ?', [fileId, userId]);
  if (share) return { found: true, file, canView: true, canEdit: !!share.can_edit, via: 'share' };
  if (file.visibility === 'company') return { found: true, file, canView: true, canEdit: false, via: 'company' };
  return { found: true, file, canView: false, canEdit: false };
}

async function visibilityClause(userId) {
  if (await isSystemAdmin(userId)) return { sql: null, params: [] };
  return {
    sql: `(f.visibility = 'company' OR f.owner_user_id = ?
           OR EXISTS (SELECT 1 FROM archive_file_shares s WHERE s.file_id = f.id AND s.user_id = ?))`,
    params: [userId, userId],
  };
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [folders] = await pool.query('SELECT id, name, description FROM archive_file_folders WHERE is_active = TRUE ORDER BY name');
    const [users] = await pool.query('SELECT id, display_name, username FROM users WHERE is_active = TRUE ORDER BY display_name');
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    res.json({
      folders, users, departments,
      statuses: [...STATUSES],
      max_bytes: MAX_BYTES,
      allowed_types: [...ALLOWED_MIME],
    });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, folder_id: folderId, status, expiring } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.page_size) || DEFAULT_PAGE_SIZE));

    const where = [];
    const params = [];
    const vis = await visibilityClause(req.user.id);
    if (vis.sql) { where.push(vis.sql); params.push(...vis.params); }
    if (folderId) { where.push('f.folder_id = ?'); params.push(folderId); }
    if (status) { where.push('f.status = ?'); params.push(status); }
    if (expiring === 'yes') where.push('f.expires_on IS NOT NULL AND f.expires_on <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)');
    // Anything filed against a job order, i.e. the artist archives.
    if (req.query.artist_only === 'yes') where.push('f.source_kind IS NOT NULL');
    if (req.query.jo_no) { where.push('f.jo_no = ?'); params.push(req.query.jo_no); }
    // "Mine" means the artist the work was filed FOR, not whoever pressed upload -- a supervisor
    // filing on someone's behalf should still list under that artist.
    if (req.query.mine === 'yes') {
      const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
      where.push('f.artist_employee_id = ?');
      params.push(me?.employee_id || 0);
    }
    if (search) {
      // The job order number is what anyone hunting for layout files will actually type.
      where.push('(f.title LIKE ? OR f.description LIKE ? OR f.reference_no LIKE ? OR f.file_no LIKE ?'
        + ' OR f.jo_no LIKE ? OR f.customer_name LIKE ? OR f.artist_name LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM archive_files f ${whereSql}`, params);
    const [rows] = await pool.query(
      `SELECT ${FILE_COLUMNS}, fo.name AS folder_name, o.display_name AS owner_name, d.name AS department_name,
              v.file_name, v.mime_type, v.created_at AS version_uploaded_at,
              -- size_bytes is INT and caps at ~2GB; size_bytes_large is the real figure.
              COALESCE(v.size_bytes_large, v.size_bytes) AS size_bytes,
              v.storage, v.upload_status
         FROM archive_files f
         LEFT JOIN archive_file_folders fo ON fo.id = f.folder_id
         LEFT JOIN users o ON o.id = f.owner_user_id
         LEFT JOIN departments d ON d.id = f.department_id
         LEFT JOIN archive_file_versions v ON v.file_id = f.id AND v.version_no = f.current_version
         ${whereSql} ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    res.json({ rows, total, page, page_size: pageSize });
  } catch (err) { next(err); }
});

// The job orders this user may archive against.
//
// Restricted to the caller's OWN assigned work, because "assigned to them" is the whole premise --
// an artist filing someone else's job would put the wrong name on the archive permanently, since
// the details are snapshotted. A System Admin is unrestricted, for the case where work has to be
// filed on behalf of someone who has left.
//
// Deliberately NOT limited to the active layout queue the Assigned JO page uses: archiving happens
// when the work is finished, which is exactly when a job order has left that queue.
router.get('/my-job-orders', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search } = req.query;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));

    const [[me]] = await pool.query('SELECT employee_id, account_type FROM users WHERE id = ?', [req.user.id]);
    const isAdmin = me?.account_type === 'System Admin';
    if (!isAdmin && !me?.employee_id) {
      return res.json({ rows: [], reason: 'Your account is not linked to an employee record, so no assigned job orders can be found.' });
    }

    const joWhere = [];
    const joParams = [];
    if (!isAdmin) { joWhere.push('jo.artist_id = ?'); joParams.push(me.employee_id); }
    else joWhere.push('jo.artist_id IS NOT NULL');
    if (search) {
      joWhere.push('(jo.job_order_no LIKE ? OR jo.description LIKE ? OR c.name LIKE ?)');
      const like = `%${search}%`;
      joParams.push(like, like, like);
    }

    // The same sales-rep fallback the artist's worklist uses -- the job order's own rep if it has
    // one, otherwise the sales order's -- so the archive names whoever the artist would have asked.
    const [jos] = await pool.query(
      `SELECT 'JO' AS source_kind, jo.id AS source_id, jo.job_order_no AS jo_no,
              DATE(jo.created_at) AS jo_date, jo.description AS job_description,
              c.name AS customer_name,
              COALESCE(CONCAT(jsr.first_name, ' ', jsr.last_name),
                       CONCAT(ssr.first_name, ' ', ssr.last_name)) AS sales_rep_name,
              CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name, jo.artist_id AS artist_employee_id,
              pjt.display_name AS layout_job_type,
              (SELECT COUNT(*) FROM archive_files af WHERE af.source_kind = 'JO' AND af.source_id = jo.id) AS archived_count
         FROM job_orders jo
         LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
         LEFT JOIN customers c ON c.id = so.customer_id
         LEFT JOIN employees jsr ON jsr.id = jo.sales_rep_id
         LEFT JOIN employees ssr ON ssr.id = so.sales_rep_id
         LEFT JOIN employees ar ON ar.id = jo.artist_id
         LEFT JOIN pms_job_types pjt ON pjt.id = jo.layout_job_type_id
        WHERE ${joWhere.join(' AND ')}
        ORDER BY jo.id DESC LIMIT ?`,
      [...joParams, limit],
    );

    const nWhere = [];
    const nParams = [];
    if (!isAdmin) { nWhere.push('n.artist_employee_id = ?'); nParams.push(me.employee_id); }
    else nWhere.push('n.artist_employee_id IS NOT NULL');
    if (search) {
      nWhere.push('(n.nstdjo_no LIKE ? OR n.description LIKE ? OR c.name LIKE ?)');
      const like = `%${search}%`;
      nParams.push(like, like, like);
    }

    const [nstdjos] = await pool.query(
      `SELECT 'NSTDJO' AS source_kind, n.id AS source_id, n.nstdjo_no AS jo_no,
              n.date_created AS jo_date, n.description AS job_description,
              c.name AS customer_name,
              CONCAT(nsr.first_name, ' ', nsr.last_name) AS sales_rep_name,
              CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name, n.artist_employee_id,
              pjt.display_name AS layout_job_type,
              (SELECT COUNT(*) FROM archive_files af WHERE af.source_kind = 'NSTDJO' AND af.source_id = n.id) AS archived_count
         FROM non_standard_job_orders n
         LEFT JOIN customers c ON c.id = n.customer_id
         LEFT JOIN employees nsr ON nsr.id = n.sales_rep_id
         LEFT JOIN employees ar ON ar.id = n.artist_employee_id
         LEFT JOIN pms_job_types pjt ON pjt.id = n.layout_job_type_id
        WHERE ${nWhere.join(' AND ')}
        ORDER BY n.id DESC LIMIT ?`,
      [...nParams, limit],
    );

    res.json({ rows: [...jos, ...nstdjos], is_admin: isAdmin });
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const access = await fileAccess(req.user.id, req.params.id);
    if (!access.found || !access.canView) return res.status(404).json({ error: 'Not found' });

    const [[file]] = await pool.query(
      `SELECT ${FILE_COLUMNS}, fo.name AS folder_name, o.display_name AS owner_name,
              d.name AS department_name, cb.display_name AS created_by_name, ub.display_name AS updated_by_name
         FROM archive_files f
         LEFT JOIN archive_file_folders fo ON fo.id = f.folder_id
         LEFT JOIN users o ON o.id = f.owner_user_id
         LEFT JOIN departments d ON d.id = f.department_id
         LEFT JOIN users cb ON cb.id = f.created_by_user_id
         LEFT JOIN users ub ON ub.id = f.updated_by_user_id
        WHERE f.id = ?`,
      [req.params.id],
    );
    // Note the absent file_data: version history is a list of what exists, not the bytes.
    const [versions] = await pool.query(
      `SELECT v.id, v.version_no, v.file_name, v.mime_type, v.checksum_sha256,
              COALESCE(v.size_bytes_large, v.size_bytes) AS size_bytes,
              v.storage, v.upload_status, v.upload_started_at,
              v.note, v.created_at, u.display_name AS uploaded_by_name
         FROM archive_file_versions v LEFT JOIN users u ON u.id = v.uploaded_by_user_id
        WHERE v.file_id = ? ORDER BY v.version_no DESC`,
      [req.params.id],
    );
    const [shares] = await pool.query(
      `SELECT s.*, u.display_name, g.display_name AS granted_by_name
         FROM archive_file_shares s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN users g ON g.id = s.granted_by_user_id
        WHERE s.file_id = ? ORDER BY u.display_name`,
      [req.params.id],
    );
    res.json({ ...file, versions, shares, my_access: { can_edit: access.canEdit, via: access.via || null } });
  } catch (err) { next(err); }
});

router.get('/:id/logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const access = await fileAccess(req.user.id, req.params.id);
    if (!access.found || !access.canView) return res.status(404).json({ error: 'Not found' });
    const [rows] = await pool.query(
      `SELECT l.id, l.action, l.detail, l.created_at, u.display_name AS user_name
         FROM archive_file_logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.file_id = ? ORDER BY l.created_at DESC LIMIT 200`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// The only route that touches file_data on the way out. Streams the raw bytes with the original
// filename, rather than returning base64 in JSON -- a 25MB document would otherwise inflate to
// ~34MB of string that the browser then has to decode before it can save anything.
router.get('/:id/versions/:versionId/download', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const access = await fileAccess(req.user.id, req.params.id);
    if (!access.found || !access.canView) return res.status(404).json({ error: 'Not found' });

    // file_data is selected LAST and only for the in-database path -- see the branch below, which
    // returns before it is ever touched for a stored-in-Spaces version.
    const [[v]] = await pool.query(
      `SELECT file_name, mime_type, size_bytes, size_bytes_large, version_no,
              storage, storage_key, upload_status
         FROM archive_file_versions WHERE id = ? AND file_id = ?`,
      [req.params.versionId, req.params.id],
    );
    if (!v) return res.status(404).json({ error: 'Version not found' });

    // A large file is fetched straight from storage on a short-lived signed URL. The bytes never
    // pass through this server: streaming 150 GB through Node would hold a connection open for
    // hours for no benefit, when storage can serve it directly.
    if (v.storage === 'spaces') {
      if (v.upload_status !== 'complete') {
        return res.status(409).json({ error: `This upload is ${v.upload_status} and cannot be downloaded yet.` });
      }
      const url = await storage.signDownload(v.storage_key, v.file_name);
      await logFile(null, req, {
        fileId: req.params.id, versionId: req.params.versionId,
        action: 'downloaded', detail: `v${v.version_no} ${v.file_name} (storage)`,
      });
      // Handed back as JSON rather than a 302, so the client can show progress and errors instead
      // of the browser silently following a redirect it cannot report on.
      return res.json({ url, expires_in: storage.DOWNLOAD_URL_TTL, file_name: v.file_name, size_bytes: v.size_bytes_large });
    }

    const [[blob]] = await pool.query(
      'SELECT file_data FROM archive_file_versions WHERE id = ?', [req.params.versionId],
    );
    v.file_data = blob?.file_data;

    await logFile(null, req, {
      fileId: req.params.id, versionId: req.params.versionId,
      action: 'downloaded', detail: `v${v.version_no} ${v.file_name}`,
    });

    res.setHeader('Content-Type', v.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', v.size_bytes);
    // Quotes and backslashes escaped: an unescaped quote in a filename truncates the header and
    // the browser saves the file under a mangled name.
    const safeName = String(v.file_name).replace(/["\\]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(v.file_data);
  } catch (err) { next(err); }
});

// Decodes and checks an uploaded base64 payload. Returns the buffer, or an error string.
function readUpload(b) {
  if (!b.file_data) return { error: 'No file was attached.' };
  if (!b.file_name) return { error: 'The file has no name.' };

  const mime = b.mime_type || 'application/octet-stream';
  if (!ALLOWED_MIME.has(mime)) {
    return { error: `Files of type ${mime} are not accepted here. Allowed: PDF, images, Office documents, text, CSV and ZIP.` };
  }

  // Tolerates a data: URL prefix, which is what a browser FileReader produces.
  const base64 = String(b.file_data).replace(/^data:[^;]*;base64,/, '');
  let buffer;
  try { buffer = Buffer.from(base64, 'base64'); } catch { return { error: 'The file could not be read.' }; }
  if (!buffer.length) return { error: 'The file is empty.' };
  if (buffer.length > MAX_BYTES) {
    return { error: `That file is ${(buffer.length / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_BYTES / 1024 / 1024}MB.` };
  }

  // Stored so a download can be checked against what was uploaded -- the cheap way to notice
  // silent corruption in a blob that may sit untouched for years.
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
  return { buffer, mime, checksum, fileName: trunc(b.file_name, 255) };
}

// ---------------------------------------------------------------------------------------------
// Artist archives: the working files for a job order, filed by the artist who did the layout.
// ---------------------------------------------------------------------------------------------

// What an artist may archive against a job order.
//
// Artwork is usually a folder -- the layout, its links, its fonts -- so it arrives as one archive,
// zip or rar. A PDF is allowed too because a print-ready proof is a single file and zipping it
// achieves nothing.
//
// Keyed on the EXTENSION, with the browser's MIME type accepted only as corroboration. Browsers
// report archives inconsistently: rar in particular comes through as any of four types depending
// on the platform, and some report application/octet-stream for everything. Trusting the MIME
// alone would reject perfectly good files on one machine and accept them on another.
const ARTIST_FILE_TYPES = {
  '.zip': { mime: 'application/zip', label: 'ZIP' },
  '.rar': { mime: 'application/vnd.rar', label: 'RAR' },
  '.pdf': { mime: 'application/pdf', label: 'PDF' },
};
const ARTIST_EXTENSIONS = Object.keys(ARTIST_FILE_TYPES);

// Returns the canonical type for a filename, or null if it is not one we accept. The canonical
// MIME is what gets stored, so the archive records one consistent type per extension however the
// uploader's browser happened to label it.
function artistFileType(fileName) {
  const match = String(fileName || '').toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match ? (ARTIST_FILE_TYPES[match[1]] || null) : null;
}

// --- Large uploads, straight to object storage ------------------------------------------------
//
// Layout archives run to tens of gigabytes, which cannot go in the database: a LONGBLOB caps at
// 4 GB and the droplet has ~55 GB of disk. So the browser uploads DIRECTLY to object storage and
// this server only ever handles metadata and signatures -- proxying 150 GB through Node would tie
// up the process for hours.
//
// The sequence, driven by the client:
//   1. POST /artist/init      -> creates the archive row and a multipart upload, returns part plan
//   2. GET  /upload/:id/part  -> one presigned URL per part, fetched as the upload reaches it
//   3. POST /upload/:id/complete -> finishes the multipart and marks the archive usable
//   4. POST /upload/:id/abort -> cleans up if it fails or is cancelled
//
// An archive is not a usable file until step 3. A half-uploaded 150 GB object that looks like an
// archive is worse than no archive at all, so upload_status gates it.

// Everything needed to snapshot a job order onto an archive, shared by the small-file and
// large-file paths so the two cannot record different things about the same job.
async function readJobOrderForArchive(conn, kind, sourceId) {
  if (kind === 'JO') {
    const [[row]] = await conn.query(
      `SELECT jo.job_order_no AS jo_no, DATE(jo.created_at) AS jo_date, jo.description AS job_description,
              jo.artist_id AS artist_employee_id, c.name AS customer_name,
              COALESCE(CONCAT(jsr.first_name, ' ', jsr.last_name),
                       CONCAT(ssr.first_name, ' ', ssr.last_name)) AS sales_rep_name,
              CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name,
              pjt.display_name AS layout_job_type
         FROM job_orders jo
         LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
         LEFT JOIN customers c ON c.id = so.customer_id
         LEFT JOIN employees jsr ON jsr.id = jo.sales_rep_id
         LEFT JOIN employees ssr ON ssr.id = so.sales_rep_id
         LEFT JOIN employees ar ON ar.id = jo.artist_id
         LEFT JOIN pms_job_types pjt ON pjt.id = jo.layout_job_type_id
        WHERE jo.id = ?`,
      [sourceId],
    );
    return row;
  }
  const [[row]] = await conn.query(
    `SELECT n.nstdjo_no AS jo_no, n.date_created AS jo_date, n.description AS job_description,
            n.artist_employee_id, c.name AS customer_name,
            CONCAT(nsr.first_name, ' ', nsr.last_name) AS sales_rep_name,
            CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name,
            pjt.display_name AS layout_job_type
       FROM non_standard_job_orders n
       LEFT JOIN customers c ON c.id = n.customer_id
       LEFT JOIN employees nsr ON nsr.id = n.sales_rep_id
       LEFT JOIN employees ar ON ar.id = n.artist_employee_id
       LEFT JOIN pms_job_types pjt ON pjt.id = n.layout_job_type_id
      WHERE n.id = ?`,
    [sourceId],
  );
  return row;
}

// Start a large artist upload. Creates the archive row and the multipart upload, and hands back
// the part plan the browser will follow.
router.post('/artist/init', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    const kind = b.source_kind === 'NSTDJO' ? 'NSTDJO' : 'JO';
    if (!b.source_id) return res.status(400).json({ error: 'Choose the job order this belongs to.' });
    const fileType = artistFileType(b.file_name);
    if (!fileType) {
      return res.status(400).json({ error: `Artist archives must be one of: ${ARTIST_EXTENSIONS.join(', ')}.` });
    }
    if (!storage.isConfigured()) {
      return res.status(503).json({
        error: 'Large-file storage is not configured on this server, so files above the in-database limit cannot be archived. Ask a System Administrator to set up the archive bucket.',
      });
    }

    const plan = storage.planUpload(b.size_bytes);
    if (plan.error) return res.status(400).json({ error: plan.error });

    const [[me]] = await conn.query('SELECT employee_id, account_type FROM users WHERE id = ?', [req.user.id]);
    const isAdmin = me?.account_type === 'System Admin';
    const jo = await readJobOrderForArchive(conn, kind, b.source_id);
    if (!jo) return res.status(404).json({ error: 'That job order was not found.' });
    if (!isAdmin && String(jo.artist_employee_id ?? '') !== String(me?.employee_id ?? '')) {
      return res.status(403).json({ error: 'That job order is not assigned to you.' });
    }

    const key = storage.buildKey({ jobOrderNo: jo.jo_no, fileName: b.file_name });
    const created = await storage.createMultipartUpload(key, fileType.mime);
    const [[folder]] = await conn.query("SELECT id FROM archive_file_folders WHERE name = 'Artist Layout Files'");

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO archive_files
         (file_no, title, folder_id, description, reference_no, source_kind, source_id,
          jo_no, jo_date, customer_name, sales_rep_name, artist_name, layout_job_type,
          job_description, artist_employee_id, document_date, owner_user_id, visibility, status,
          current_version, created_by_user_id)
       VALUES ('', ?,?,?,?, ?,?, ?,?,?,?,?,?, ?,?, ?,?, 'shared', 'active', 1, ?)`,
      [trunc(`${jo.jo_no} — ${jo.layout_job_type || 'Layout'}`, 200), folder?.id || null,
        trunc(b.note, 2000), trunc(jo.jo_no, 200), kind, b.source_id,
        trunc(jo.jo_no, 60), jo.jo_date || null, trunc(jo.customer_name, 255),
        trunc(jo.sales_rep_name, 255), trunc(jo.artist_name, 255), trunc(jo.layout_job_type, 200),
        trunc(jo.job_description, 500), jo.artist_employee_id || null,
        jo.jo_date || null, req.user.id, req.user.id],
    );
    const fileId = r.insertId;
    const fileNo = `DOC-${fileId}`;
    await conn.query('UPDATE archive_files SET file_no = ? WHERE id = ?', [fileNo, fileId]);

    const [v] = await conn.query(
      `INSERT INTO archive_file_versions
         (file_id, version_no, storage, storage_key, storage_bucket, upload_id, upload_status,
          upload_started_at, file_name, mime_type, size_bytes, size_bytes_large, note, uploaded_by_user_id)
       VALUES (?, 1, 'spaces', ?,?,?, 'uploading', NOW(), ?, ?, 0, ?, ?, ?)`,
      [fileId, created.key, created.bucket, created.uploadId, trunc(b.file_name, 255),
        fileType.mime, plan.size, trunc(b.note, 500) || 'Artist layout files', req.user.id],
    );
    await logFile(conn, req, {
      fileId, versionId: v.insertId, action: 'upload_started',
      detail: `${jo.jo_no} · ${b.file_name} · ${(plan.size / 1024 ** 3).toFixed(2)}GB in ${plan.partCount} parts`,
    });
    await conn.commit();

    res.status(201).json({
      file_id: fileId, file_no: fileNo, version_id: v.insertId,
      part_size: plan.partSize, part_count: plan.partCount, jo_no: jo.jo_no,
    });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// One presigned URL for one part. Signed on demand rather than all at once: 1,500 URLs would be a
// huge response, and they expire long before a multi-hour upload would reach the last of them.
router.get('/upload/:versionId/part', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const partNumber = Number(req.query.part_number);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > storage.MAX_PARTS) {
      return res.status(400).json({ error: 'Invalid part number.' });
    }
    const [[v]] = await pool.query(
      `SELECT v.*, f.owner_user_id FROM archive_file_versions v
         JOIN archive_files f ON f.id = v.file_id WHERE v.id = ?`,
      [req.params.versionId],
    );
    if (!v || v.storage !== 'spaces') return res.status(404).json({ error: 'Upload not found.' });
    if (v.upload_status !== 'uploading') return res.status(409).json({ error: `This upload is already ${v.upload_status}.` });
    // Only whoever started the upload may keep feeding it parts.
    if (String(v.uploaded_by_user_id) !== String(req.user.id) && !(await isSystemAdmin(req.user.id))) {
      return res.status(403).json({ error: 'This upload belongs to someone else.' });
    }
    res.json({ url: await storage.signPart(v.storage_key, v.upload_id, partNumber), part_number: partNumber });
  } catch (err) { next(err); }
});

// Finish the upload. The size is read back from storage rather than trusted from the browser --
// it is the only way to know the object is actually all there.
router.post('/upload/:versionId/complete', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const parts = Array.isArray(req.body?.parts) ? req.body.parts : null;
    if (!parts || !parts.length) return res.status(400).json({ error: 'No uploaded parts were reported.' });

    const [[v]] = await conn.query('SELECT * FROM archive_file_versions WHERE id = ?', [req.params.versionId]);
    if (!v || v.storage !== 'spaces') return res.status(404).json({ error: 'Upload not found.' });
    if (v.upload_status !== 'uploading') return res.status(409).json({ error: `This upload is already ${v.upload_status}.` });
    if (String(v.uploaded_by_user_id) !== String(req.user.id) && !(await isSystemAdmin(req.user.id))) {
      return res.status(403).json({ error: 'This upload belongs to someone else.' });
    }

    const done = await storage.completeMultipartUpload(v.storage_key, v.upload_id, parts.map((p) => ({
      PartNumber: Number(p.part_number ?? p.PartNumber), ETag: String(p.etag ?? p.ETag),
    })));
    const head = await storage.headObject(v.storage_key);

    await conn.beginTransaction();
    await conn.query(
      `UPDATE archive_file_versions
          SET upload_status = 'complete', storage_etag = ?, size_bytes_large = ?,
              size_bytes = LEAST(?, 2147483647), upload_id = NULL
        WHERE id = ?`,
      [done.etag || head.etag, head.size, head.size, v.id],
    );
    await logFile(conn, req, {
      fileId: v.file_id, versionId: v.id, action: 'upload_completed',
      detail: `${(head.size / 1024 ** 3).toFixed(2)}GB in ${parts.length} parts`,
    });
    await conn.commit();
    res.json({ ok: true, size_bytes: head.size });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Cancel or clean up after a failure. Aborting the multipart matters for more than tidiness:
// abandoned parts stay in the bucket, invisible and still billed.
router.post('/upload/:versionId/abort', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[v]] = await conn.query('SELECT * FROM archive_file_versions WHERE id = ?', [req.params.versionId]);
    if (!v || v.storage !== 'spaces') return res.status(404).json({ error: 'Upload not found.' });
    if (String(v.uploaded_by_user_id) !== String(req.user.id) && !(await isSystemAdmin(req.user.id))) {
      return res.status(403).json({ error: 'This upload belongs to someone else.' });
    }
    if (v.upload_status === 'uploading' && v.upload_id) {
      try { await storage.abortMultipartUpload(v.storage_key, v.upload_id); }
      catch { /* already gone at the storage end; the row still has to be cleaned up */ }
    }

    await conn.beginTransaction();
    // The archive row exists only to hold this upload, so an abandoned upload takes it with it --
    // otherwise the list fills with entries that look like archives and contain nothing.
    const [[{ n }]] = await conn.query('SELECT COUNT(*) n FROM archive_file_versions WHERE file_id = ?', [v.file_id]);
    await conn.query('DELETE FROM archive_file_versions WHERE id = ?', [v.id]);
    if (n <= 1) await conn.query('DELETE FROM archive_files WHERE id = ?', [v.file_id]);
    await logFile(conn, req, { fileId: n <= 1 ? null : v.file_id, action: 'upload_aborted', detail: v.file_name });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// File the working files against a job order. Snapshots the job order's details onto the archive.
router.post('/artist', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    const kind = b.source_kind === 'NSTDJO' ? 'NSTDJO' : 'JO';
    if (!b.source_id) return res.status(400).json({ error: 'Choose the job order this belongs to.' });
    const fileType = artistFileType(b.file_name);
    if (!fileType) {
      return res.status(400).json({
        error: `Artist archives must be one of: ${ARTIST_EXTENSIONS.join(', ')}. Put a layout and its links and fonts into one archive.`,
      });
    }

    // The canonical MIME for the extension, not whatever the browser claimed -- rar alone is
    // reported four different ways depending on the platform.
    const upload = readUpload({ ...b, mime_type: fileType.mime });
    if (upload.error) return res.status(400).json({ error: upload.error });

    const [[me]] = await conn.query('SELECT employee_id, account_type FROM users WHERE id = ?', [req.user.id]);
    const isAdmin = me?.account_type === 'System Admin';

    // Re-read the job order server-side rather than trusting the details the form sent. The client
    // showed them for confirmation; what gets frozen into the archive has to come from the record.
    let jo = null;
    if (kind === 'JO') {
      const [[row]] = await conn.query(
        `SELECT jo.job_order_no AS jo_no, DATE(jo.created_at) AS jo_date, jo.description AS job_description,
                jo.artist_id AS artist_employee_id, c.name AS customer_name,
                COALESCE(CONCAT(jsr.first_name, ' ', jsr.last_name),
                         CONCAT(ssr.first_name, ' ', ssr.last_name)) AS sales_rep_name,
                CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name,
                pjt.display_name AS layout_job_type
           FROM job_orders jo
           LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
           LEFT JOIN customers c ON c.id = so.customer_id
           LEFT JOIN employees jsr ON jsr.id = jo.sales_rep_id
           LEFT JOIN employees ssr ON ssr.id = so.sales_rep_id
           LEFT JOIN employees ar ON ar.id = jo.artist_id
           LEFT JOIN pms_job_types pjt ON pjt.id = jo.layout_job_type_id
          WHERE jo.id = ?`,
        [b.source_id],
      );
      jo = row;
    } else {
      const [[row]] = await conn.query(
        `SELECT n.nstdjo_no AS jo_no, n.date_created AS jo_date, n.description AS job_description,
                n.artist_employee_id, c.name AS customer_name,
                CONCAT(nsr.first_name, ' ', nsr.last_name) AS sales_rep_name,
                CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name,
                pjt.display_name AS layout_job_type
           FROM non_standard_job_orders n
           LEFT JOIN customers c ON c.id = n.customer_id
           LEFT JOIN employees nsr ON nsr.id = n.sales_rep_id
           LEFT JOIN employees ar ON ar.id = n.artist_employee_id
           LEFT JOIN pms_job_types pjt ON pjt.id = n.layout_job_type_id
          WHERE n.id = ?`,
        [b.source_id],
      );
      jo = row;
    }
    if (!jo) return res.status(404).json({ error: 'That job order was not found.' });
    if (!isAdmin && String(jo.artist_employee_id ?? '') !== String(me?.employee_id ?? '')) {
      return res.status(403).json({ error: 'That job order is not assigned to you.' });
    }

    const [[folder]] = await conn.query("SELECT id FROM archive_file_folders WHERE name = 'Artist Layout Files'");

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO archive_files
         (file_no, title, folder_id, description, reference_no, source_kind, source_id,
          jo_no, jo_date, customer_name, sales_rep_name, artist_name, layout_job_type,
          job_description, artist_employee_id, document_date, owner_user_id, visibility, status,
          current_version, created_by_user_id)
       VALUES ('', ?,?,?,?, ?,?, ?,?,?,?,?,?, ?,?, ?,?, 'shared', 'active', 1, ?)`,
      [
        // The title is built rather than typed: an archive people search by job order number is
        // only findable if every row is named the same way.
        trunc(`${jo.jo_no} — ${jo.layout_job_type || 'Layout'}`, 200),
        folder?.id || null,
        trunc(b.note, 2000),
        trunc(jo.jo_no, 200),
        kind, b.source_id,
        trunc(jo.jo_no, 60), jo.jo_date || null, trunc(jo.customer_name, 255),
        trunc(jo.sales_rep_name, 255), trunc(jo.artist_name, 255), trunc(jo.layout_job_type, 200),
        trunc(jo.job_description, 500), jo.artist_employee_id || null,
        jo.jo_date || null, req.user.id, req.user.id,
      ],
    );
    const fileId = r.insertId;
    const fileNo = `DOC-${fileId}`;
    await conn.query('UPDATE archive_files SET file_no = ? WHERE id = ?', [fileNo, fileId]);

    await conn.query(
      `INSERT INTO archive_file_versions
         (file_id, version_no, file_name, mime_type, size_bytes, checksum_sha256, file_data, note, uploaded_by_user_id)
       VALUES (?, 1, ?,?,?,?,?,?,?)`,
      [fileId, upload.fileName, upload.mime, upload.buffer.length, upload.checksum, upload.buffer,
        trunc(b.note, 500) || 'Artist layout files', req.user.id],
    );
    await logFile(conn, req, { fileId, action: 'created', detail: `${fileNo} · ${jo.jo_no} · ${upload.fileName}` });
    await conn.commit();
    res.status(201).json({ id: fileId, file_no: fileNo, jo_no: jo.jo_no });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'A title is required.' });
    if (b.status && !STATUSES.has(b.status)) return res.status(400).json({ error: `Unknown status: ${b.status}` });

    const upload = readUpload(b);
    if (upload.error) return res.status(400).json({ error: upload.error });

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO archive_files
         (file_no, title, folder_id, description, reference_no, document_date, expires_on,
          owner_user_id, department_id, visibility, status, current_version, created_by_user_id)
       VALUES ('', ?,?,?,?,?,?, ?,?,?,?, 1, ?)`,
      [trunc(b.title, 200), idOrNull(b.folder_id), trunc(b.description, 2000), trunc(b.reference_no, 200),
        b.document_date || null, b.expires_on || null,
        idOrNull(b.owner_user_id) || req.user.id, idOrNull(b.department_id),
        b.visibility === 'company' ? 'company' : 'shared', b.status || 'active', req.user.id],
    );
    const fileId = r.insertId;
    const fileNo = `DOC-${fileId}`;
    await conn.query('UPDATE archive_files SET file_no = ? WHERE id = ?', [fileNo, fileId]);

    await conn.query(
      `INSERT INTO archive_file_versions
         (file_id, version_no, file_name, mime_type, size_bytes, checksum_sha256, file_data, note, uploaded_by_user_id)
       VALUES (?, 1, ?,?,?,?,?,?,?)`,
      [fileId, upload.fileName, upload.mime, upload.buffer.length, upload.checksum, upload.buffer,
        trunc(b.note, 500) || 'Initial upload', req.user.id],
    );

    for (const s of (Array.isArray(b.shares) ? b.shares : [])) {
      if (!s.user_id || String(s.user_id) === String(idOrNull(b.owner_user_id) || req.user.id)) continue;
      await conn.query(
        'INSERT IGNORE INTO archive_file_shares (file_id, user_id, can_edit, granted_by_user_id) VALUES (?,?,?,?)',
        [fileId, s.user_id, !!s.can_edit, req.user.id],
      );
    }
    await logFile(conn, req, { fileId, action: 'created', detail: `${fileNo} ${upload.fileName}` });
    await conn.commit();
    res.status(201).json({ id: fileId, file_no: fileNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Metadata only. New bytes go through /versions, so an edit can never quietly swap the document.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const b = req.body;
    const access = await fileAccess(req.user.id, req.params.id);
    if (!access.found || !access.canView) return res.status(404).json({ error: 'Not found' });
    if (!access.canEdit) return res.status(403).json({ error: 'You do not have edit access to this document.' });
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'A title is required.' });
    if (b.status && !STATUSES.has(b.status)) return res.status(400).json({ error: `Unknown status: ${b.status}` });

    await pool.query(
      `UPDATE archive_files SET title = ?, folder_id = ?, description = ?, reference_no = ?,
              document_date = ?, expires_on = ?, owner_user_id = ?, department_id = ?,
              visibility = ?, status = ?, updated_by_user_id = ?, updated_at = NOW()
        WHERE id = ?`,
      [trunc(b.title, 200), idOrNull(b.folder_id), trunc(b.description, 2000), trunc(b.reference_no, 200),
        b.document_date || null, b.expires_on || null,
        idOrNull(b.owner_user_id) || access.file.owner_user_id, idOrNull(b.department_id),
        b.visibility === 'company' ? 'company' : 'shared', b.status || 'active', req.user.id, req.params.id],
    );
    await logFile(null, req, { fileId: req.params.id, action: 'updated' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// A new copy of the document. Adds a version; the previous one stays readable.
router.post('/:id/versions', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const access = await fileAccess(req.user.id, req.params.id, conn);
    if (!access.found || !access.canView) return res.status(404).json({ error: 'Not found' });
    if (!access.canEdit) return res.status(403).json({ error: 'You do not have edit access to this document.' });

    const upload = readUpload(req.body);
    if (upload.error) return res.status(400).json({ error: upload.error });

    await conn.beginTransaction();
    // MAX + 1 rather than current_version + 1, so a version is never reused if one was ever
    // removed -- a reused number would make two different documents share an identity in the log.
    const [[{ nextNo }]] = await conn.query(
      'SELECT COALESCE(MAX(version_no), 0) + 1 AS nextNo FROM archive_file_versions WHERE file_id = ?',
      [req.params.id],
    );
    const [r] = await conn.query(
      `INSERT INTO archive_file_versions
         (file_id, version_no, file_name, mime_type, size_bytes, checksum_sha256, file_data, note, uploaded_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [req.params.id, nextNo, upload.fileName, upload.mime, upload.buffer.length, upload.checksum,
        upload.buffer, trunc(req.body.note, 500), req.user.id],
    );
    await conn.query('UPDATE archive_files SET current_version = ?, updated_by_user_id = ?, updated_at = NOW() WHERE id = ?',
      [nextNo, req.user.id, req.params.id]);
    await logFile(conn, req, { fileId: req.params.id, versionId: r.insertId, action: 'version_added', detail: `v${nextNo} ${upload.fileName}` });
    await conn.commit();
    res.status(201).json({ ok: true, version_no: nextNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.post('/:id/shares', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const access = await fileAccess(req.user.id, req.params.id);
    if (!access.found || !access.canView) return res.status(404).json({ error: 'Not found' });
    if (!access.canEdit) return res.status(403).json({ error: 'You do not have edit access to this document.' });

    const { user_id: userId, can_edit: canEdit } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Choose a user to share with.' });
    if (String(userId) === String(access.file.owner_user_id)) return res.status(400).json({ error: 'That user already owns this document.' });
    const [[target]] = await pool.query('SELECT display_name FROM users WHERE id = ? AND is_active = TRUE', [userId]);
    if (!target) return res.status(400).json({ error: 'User not found.' });

    await pool.query(
      `INSERT INTO archive_file_shares (file_id, user_id, can_edit, granted_by_user_id) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE can_edit = VALUES(can_edit), granted_by_user_id = VALUES(granted_by_user_id), granted_at = NOW()`,
      [req.params.id, userId, !!canEdit, req.user.id],
    );
    await logFile(null, req, { fileId: req.params.id, action: 'share_granted', detail: `${target.display_name}${canEdit ? ' (can edit)' : ''}` });
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/:id/shares/:userId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const access = await fileAccess(req.user.id, req.params.id);
    if (!access.found || !access.canView) return res.status(404).json({ error: 'Not found' });
    if (!access.canEdit) return res.status(403).json({ error: 'You do not have edit access to this document.' });
    const [[target]] = await pool.query('SELECT display_name FROM users WHERE id = ?', [req.params.userId]);
    const [r] = await pool.query('DELETE FROM archive_file_shares WHERE file_id = ? AND user_id = ?', [req.params.id, req.params.userId]);
    if (!r.affectedRows) return res.status(404).json({ error: 'That share does not exist.' });
    await logFile(null, req, { fileId: req.params.id, action: 'share_revoked', detail: target?.display_name || String(req.params.userId) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Deleting destroys every version. Owner or System Admin only -- an edit share is not enough to
// erase a record somebody else may be relying on.
router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const access = await fileAccess(req.user.id, req.params.id, conn);
    if (!access.found || !access.canView) return res.status(404).json({ error: 'Not found' });
    if (access.via === 'share' || access.via === 'company') {
      return res.status(403).json({ error: 'Only the owner or a System Admin can delete a document.' });
    }
    await conn.beginTransaction();
    await conn.query('DELETE FROM archive_file_shares WHERE file_id = ?', [req.params.id]);
    await conn.query('DELETE FROM archive_file_versions WHERE file_id = ?', [req.params.id]);
    await conn.query('DELETE FROM archive_files WHERE id = ?', [req.params.id]);
    // The log rows survive with a null file_id: what was deleted, by whom and when is the part
    // someone will ask about afterwards.
    await logFile(conn, req, { fileId: null, action: 'deleted', detail: `${access.file.file_no} ${access.file.title}` });
    await conn.commit();
    res.status(204).send();
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
