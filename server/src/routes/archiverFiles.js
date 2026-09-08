const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth, requirePermission, isSystemAdmin } = require('../middleware/auth');

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
]);

const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
const idOrNull = (v) => (v == null || v === '' ? null : v);

// Everything except file_data. Written out once so no query can widen into the blob by accident.
const FILE_COLUMNS = `f.id, f.file_no, f.title, f.folder_id, f.description, f.reference_no,
  f.document_date, f.expires_on, f.owner_user_id, f.department_id, f.visibility, f.status,
  f.current_version, f.created_by_user_id, f.created_at, f.updated_at`;

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
    if (search) {
      where.push('(f.title LIKE ? OR f.description LIKE ? OR f.reference_no LIKE ? OR f.file_no LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM archive_files f ${whereSql}`, params);
    const [rows] = await pool.query(
      `SELECT ${FILE_COLUMNS}, fo.name AS folder_name, o.display_name AS owner_name, d.name AS department_name,
              v.file_name, v.mime_type, v.size_bytes, v.created_at AS version_uploaded_at
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
      `SELECT v.id, v.version_no, v.file_name, v.mime_type, v.size_bytes, v.checksum_sha256,
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

    const [[v]] = await pool.query(
      'SELECT file_name, mime_type, size_bytes, file_data, version_no FROM archive_file_versions WHERE id = ? AND file_id = ?',
      [req.params.versionId, req.params.id],
    );
    if (!v) return res.status(404).json({ error: 'Version not found' });

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
