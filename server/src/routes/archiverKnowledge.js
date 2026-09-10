const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const storage = require('../lib/objectStorage');

const router = express.Router();

// Archiver > Knowledge Base: reference material, two levels deep.
//
//   Products / Equipment / Technical Problem   <- sections, seeded and fixed
//     LFP, DPOD, SIGNAGE, CNC, or whatever      <- topics, freely added
//       files                                   <- what people actually came for
//
// Files follow the same rule as Archiver > Files rather than a second one: small ones stay in the
// database so the office box can read them with the internet down, large ones go to object
// storage. Sharing the rule means one thing to reason about, and one place where a bug can hide.
//
// Unlike Credentials and Files there is no per-item sharing here. A knowledge base whose articles
// are individually shared is not a knowledge base -- the whole point is that the person who needs
// the manual at 11pm can find it. Page permission decides who gets in at all.
const ROUTE = '/archiver/knowledge-base';

// PDF, Word, Excel, PowerPoint, images and plain text. An allow-list rather than a block-list:
// a store that takes anything becomes a way to pass executables around. Note the absence of SVG,
// which is a document that can carry script, not a picture.
//
// Keyed on the extension, with the browser's MIME accepted only as corroboration -- the same
// reasoning as the artist archives, where a .rar arrives labelled four different ways depending on
// the platform and some browsers send application/octet-stream for everything.
const EXT_MIME = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp',
  '.txt': 'text/plain', '.csv': 'text/csv', '.rtf': 'application/rtf',
};
const ALLOWED_EXTENSIONS = Object.keys(EXT_MIME);

// Above this a file goes to object storage instead of the database. Matches Archiver > Files.
const DB_MAX_BYTES = 25 * 1024 * 1024;

const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));

function fileTypeFor(fileName) {
  const m = String(fileName || '').toLowerCase().match(/(\.[a-z0-9]+)$/);
  return m ? (EXT_MIME[m[1]] || null) : null;
}

// Never selects file_data. Every list and detail read goes through this, so a blob cannot be
// dragged into a query that only needed a filename.
const FILE_COLUMNS = `f.id, f.topic_id, f.title, f.file_name, f.mime_type, f.size_bytes,
  f.checksum_sha256, f.storage, f.upload_status, f.note, f.uploaded_by_user_id, f.created_at`;

// --- Sections and topics: the card grid -------------------------------------------------------

// The whole tree in one call. It is three sections and a few dozen topics -- paginating that would
// cost a round trip to save nothing, and the front page wants all of it at once.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [sections] = await pool.query(
      'SELECT id, name, slug, description, sort_order, is_system FROM kb_sections WHERE is_active = TRUE ORDER BY sort_order, name',
    );
    const [topics] = await pool.query(
      `SELECT t.id, t.section_id, t.name, t.description, t.sort_order,
              (SELECT COUNT(*) FROM kb_files f WHERE f.topic_id = t.id AND f.upload_status = 'complete') AS file_count,
              (SELECT MAX(f.created_at) FROM kb_files f WHERE f.topic_id = t.id AND f.upload_status = 'complete') AS last_upload_at
         FROM kb_topics t WHERE t.is_active = TRUE ORDER BY t.sort_order, t.name`,
    );
    const bySection = new Map(sections.map((s) => [String(s.id), { ...s, topics: [] }]));
    for (const t of topics) bySection.get(String(t.section_id))?.topics.push(t);
    res.json({ sections: [...bySection.values()], storage_configured: storage.isConfigured(), db_max_bytes: DB_MAX_BYTES });
  } catch (err) { next(err); }
});

router.get('/topics/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[topic]] = await pool.query(
      `SELECT t.*, s.name AS section_name, s.slug AS section_slug, cu.display_name AS created_by_name
         FROM kb_topics t
         JOIN kb_sections s ON s.id = t.section_id
         LEFT JOIN users cu ON cu.id = t.created_by_user_id
        WHERE t.id = ?`,
      [req.params.id],
    );
    if (!topic) return res.status(404).json({ error: 'Not found' });
    const [files] = await pool.query(
      `SELECT ${FILE_COLUMNS}, u.display_name AS uploaded_by_name
         FROM kb_files f LEFT JOIN users u ON u.id = f.uploaded_by_user_id
        WHERE f.topic_id = ? ORDER BY f.created_at DESC`,
      [req.params.id],
    );
    res.json({ ...topic, files, storage_configured: storage.isConfigured(), db_max_bytes: DB_MAX_BYTES, allowed_extensions: ALLOWED_EXTENSIONS });
  } catch (err) { next(err); }
});

router.post('/topics', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const { section_id: sectionId, name, description } = req.body || {};
    if (!sectionId) return res.status(400).json({ error: 'Choose which section this belongs to.' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'A name is required.' });

    const [[section]] = await pool.query('SELECT id FROM kb_sections WHERE id = ? AND is_active = TRUE', [sectionId]);
    if (!section) return res.status(400).json({ error: 'Section not found.' });
    const [[dupe]] = await pool.query('SELECT id FROM kb_topics WHERE section_id = ? AND name = ?', [sectionId, String(name).trim()]);
    if (dupe) return res.status(400).json({ error: `"${String(name).trim()}" already exists in that section.` });

    // Appended to the end rather than inserted anywhere clever: the order people add things in is
    // usually the order they expect to see them.
    const [[{ nextOrder }]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextOrder FROM kb_topics WHERE section_id = ?', [sectionId]);
    const [r] = await pool.query(
      'INSERT INTO kb_topics (section_id, name, description, sort_order, created_by_user_id) VALUES (?,?,?,?,?)',
      [sectionId, trunc(name, 150), trunc(description, 1000), nextOrder, req.user.id],
    );
    res.status(201).json({ id: r.insertId });
  } catch (err) { next(err); }
});

router.put('/topics/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { name, description } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'A name is required.' });
    const [[topic]] = await pool.query('SELECT id, section_id FROM kb_topics WHERE id = ?', [req.params.id]);
    if (!topic) return res.status(404).json({ error: 'Not found' });
    const [[dupe]] = await pool.query(
      'SELECT id FROM kb_topics WHERE section_id = ? AND name = ? AND id <> ?',
      [topic.section_id, String(name).trim(), req.params.id],
    );
    if (dupe) return res.status(400).json({ error: `"${String(name).trim()}" already exists in that section.` });

    await pool.query(
      'UPDATE kb_topics SET name = ?, description = ?, updated_by_user_id = ?, updated_at = NOW() WHERE id = ?',
      [trunc(name, 150), trunc(description, 1000), req.user.id, req.params.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// A card with files in it is not deleted by accident. Emptying it first is a deliberate act, and
// it is the only signal that somebody meant to lose the contents.
router.delete('/topics/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM kb_files WHERE topic_id = ?', [req.params.id]);
    if (n > 0) return res.status(409).json({ error: `This card holds ${n} file(s). Remove them first.` });
    const [r] = await pool.query('DELETE FROM kb_topics WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

// --- Files ------------------------------------------------------------------------------------

function readUpload(b) {
  if (!b.file_data) return { error: 'No file was attached.' };
  if (!b.file_name) return { error: 'The file has no name.' };
  const mime = fileTypeFor(b.file_name);
  if (!mime) {
    return { error: `That file type is not accepted here. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}.` };
  }

  const base64 = String(b.file_data).replace(/^data:[^;]*;base64,/, '');
  let buffer;
  try { buffer = Buffer.from(base64, 'base64'); } catch { return { error: 'The file could not be read.' }; }
  if (!buffer.length) return { error: 'The file is empty.' };
  if (buffer.length > DB_MAX_BYTES) {
    return { error: `That file is ${(buffer.length / 1024 / 1024).toFixed(1)}MB, above the ${DB_MAX_BYTES / 1024 / 1024}MB in-database limit.` };
  }
  return { buffer, mime, checksum: crypto.createHash('sha256').update(buffer).digest('hex'), fileName: trunc(b.file_name, 255) };
}

router.post('/topics/:id/files', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const [[topic]] = await pool.query('SELECT id FROM kb_topics WHERE id = ?', [req.params.id]);
    if (!topic) return res.status(404).json({ error: 'Not found' });

    const upload = readUpload(req.body);
    if (upload.error) return res.status(400).json({ error: upload.error });

    const [r] = await pool.query(
      `INSERT INTO kb_files (topic_id, title, file_name, mime_type, size_bytes, checksum_sha256,
                             storage, file_data, upload_status, note, uploaded_by_user_id)
       VALUES (?,?,?,?,?,?, 'db', ?, 'complete', ?, ?)`,
      [req.params.id, trunc(req.body.title, 200), upload.fileName, upload.mime, upload.buffer.length,
        upload.checksum, upload.buffer, trunc(req.body.note, 500), req.user.id],
    );
    res.status(201).json({ id: r.insertId });
  } catch (err) { next(err); }
});

// Large files go straight to object storage, exactly as the artist archives do. Same three-step
// dance: init, sign each part, complete.
router.post('/topics/:id/files/init', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const [[topic]] = await pool.query(
      'SELECT t.id, t.name, s.slug FROM kb_topics t JOIN kb_sections s ON s.id = t.section_id WHERE t.id = ?',
      [req.params.id],
    );
    if (!topic) return res.status(404).json({ error: 'Not found' });
    const mime = fileTypeFor(req.body?.file_name);
    if (!mime) return res.status(400).json({ error: `That file type is not accepted here. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}.` });
    if (!storage.isConfigured()) {
      return res.status(503).json({ error: 'Large-file storage is not configured on this server, so files above the in-database limit cannot be uploaded.' });
    }

    const plan = storage.planUpload(req.body.size_bytes);
    if (plan.error) return res.status(400).json({ error: plan.error });

    const key = storage.buildKey({ jobOrderNo: `kb-${topic.slug}-${topic.name}`, fileName: req.body.file_name });
    const created = await storage.createMultipartUpload(key, mime);
    const [r] = await pool.query(
      `INSERT INTO kb_files (topic_id, title, file_name, mime_type, size_bytes, storage,
                             storage_key, storage_bucket, upload_id, upload_status, note, uploaded_by_user_id)
       VALUES (?,?,?,?,?, 'spaces', ?,?,?, 'uploading', ?, ?)`,
      [req.params.id, trunc(req.body.title, 200), trunc(req.body.file_name, 255), mime, plan.size,
        created.key, created.bucket, created.uploadId, trunc(req.body.note, 500), req.user.id],
    );
    res.status(201).json({ file_id: r.insertId, part_size: plan.partSize, part_count: plan.partCount });
  } catch (err) { next(err); }
});

router.get('/files/:id/part', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const partNumber = Number(req.query.part_number);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > storage.MAX_PARTS) {
      return res.status(400).json({ error: 'Invalid part number.' });
    }
    const [[f]] = await pool.query('SELECT * FROM kb_files WHERE id = ?', [req.params.id]);
    if (!f || f.storage !== 'spaces') return res.status(404).json({ error: 'Upload not found.' });
    if (f.upload_status !== 'uploading') return res.status(409).json({ error: `This upload is already ${f.upload_status}.` });
    if (String(f.uploaded_by_user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'This upload belongs to someone else.' });
    }
    res.json({ url: await storage.signPart(f.storage_key, f.upload_id, partNumber), part_number: partNumber });
  } catch (err) { next(err); }
});

router.post('/files/:id/complete', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const parts = Array.isArray(req.body?.parts) ? req.body.parts : null;
    if (!parts || !parts.length) return res.status(400).json({ error: 'No uploaded parts were reported.' });
    const [[f]] = await pool.query('SELECT * FROM kb_files WHERE id = ?', [req.params.id]);
    if (!f || f.storage !== 'spaces') return res.status(404).json({ error: 'Upload not found.' });
    if (f.upload_status !== 'uploading') return res.status(409).json({ error: `This upload is already ${f.upload_status}.` });
    if (String(f.uploaded_by_user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'This upload belongs to someone else.' });
    }

    const done = await storage.completeMultipartUpload(f.storage_key, f.upload_id, parts.map((p) => ({
      PartNumber: Number(p.part_number ?? p.PartNumber), ETag: String(p.etag ?? p.ETag),
    })));
    // Read back from storage rather than trusting what the browser said it sent.
    const head = await storage.headObject(f.storage_key);
    await pool.query(
      "UPDATE kb_files SET upload_status = 'complete', storage_etag = ?, size_bytes = ?, upload_id = NULL WHERE id = ?",
      [done.etag || head.etag, head.size, f.id],
    );
    res.json({ ok: true, size_bytes: head.size });
  } catch (err) { next(err); }
});

router.post('/files/:id/abort', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const [[f]] = await pool.query('SELECT * FROM kb_files WHERE id = ?', [req.params.id]);
    if (!f || f.storage !== 'spaces') return res.status(404).json({ error: 'Upload not found.' });
    if (String(f.uploaded_by_user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'This upload belongs to someone else.' });
    }
    // Abandoned parts stay in the bucket, invisible and still billed, unless the upload is aborted.
    if (f.upload_status === 'uploading' && f.upload_id) {
      try { await storage.abortMultipartUpload(f.storage_key, f.upload_id); } catch { /* already gone */ }
    }
    await pool.query('DELETE FROM kb_files WHERE id = ?', [f.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/files/:id/download', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[f]] = await pool.query(
      `SELECT id, file_name, mime_type, size_bytes, storage, storage_key, upload_status
         FROM kb_files WHERE id = ?`,
      [req.params.id],
    );
    if (!f) return res.status(404).json({ error: 'Not found' });
    if (f.upload_status !== 'complete') {
      return res.status(409).json({ error: `This upload is ${f.upload_status} and cannot be downloaded yet.` });
    }

    if (f.storage === 'spaces') {
      const url = await storage.signDownload(f.storage_key, f.file_name);
      return res.json({ url, expires_in: storage.DOWNLOAD_URL_TTL, file_name: f.file_name });
    }

    const [[blob]] = await pool.query('SELECT file_data FROM kb_files WHERE id = ?', [req.params.id]);
    res.setHeader('Content-Type', f.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', f.size_bytes);
    // Quotes and backslashes escaped: an unescaped quote truncates the header and the browser
    // saves the file under a mangled name.
    res.setHeader('Content-Disposition', `attachment; filename="${String(f.file_name).replace(/["\\]/g, '_')}"`);
    res.send(blob.file_data);
  } catch (err) { next(err); }
});

router.delete('/files/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[f]] = await pool.query('SELECT id, storage, storage_key FROM kb_files WHERE id = ?', [req.params.id]);
    if (!f) return res.status(404).json({ error: 'Not found' });
    // The object goes too. Leaving it would be an orphan nobody can find and everybody pays for.
    if (f.storage === 'spaces' && f.storage_key) {
      try { await storage.deleteObject(f.storage_key); } catch { /* already gone */ }
    }
    await pool.query('DELETE FROM kb_files WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
