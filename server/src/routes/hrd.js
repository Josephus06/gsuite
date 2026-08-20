const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/hrd';

// Matches the job-order attachment ceiling. The raised JSON body limit for this route in
// index.js is 14MB, which is what a 10MB file becomes once base64 inflates it by a third.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Rooms with their file counts and total size, so a card can say what is inside without the
// list route reading a single byte of file data.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.id, r.name, r.description, r.created_at, r.updated_at,
              u.display_name AS created_by_name,
              (SELECT COUNT(*) FROM hrd_room_files f WHERE f.room_id = r.id) AS file_count,
              (SELECT COALESCE(SUM(f.size_bytes), 0) FROM hrd_room_files f WHERE f.room_id = r.id) AS total_bytes
         FROM hrd_rooms r
         LEFT JOIN users u ON u.id = r.created_by_user_id
        ORDER BY r.name`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Room name is required.' });

    const [result] = await pool.query(
      'INSERT INTO hrd_rooms (name, description, created_by_user_id) VALUES (?, ?, ?)',
      [name.slice(0, 150), String(req.body?.description || '').trim().slice(0, 5000) || null, req.user.id],
    );
    const [[row]] = await pool.query(
      'SELECT id, name, description, created_at FROM hrd_rooms WHERE id = ?', [result.insertId],
    );
    res.status(201).json({ ...row, file_count: 0, total_bytes: 0 });
  } catch (err) {
    // The name is unique, so two people cannot both create "201 File" and end up with its
    // documents split across two identical-looking cards.
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A room with that name already exists.' });
    next(err);
  }
});

// One room and its file list. File bytes are deliberately excluded -- returning them would
// make this megabytes of base64 for a room holding a handful of documents.
router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[room]] = await pool.query(
      `SELECT r.id, r.name, r.description, r.created_at, u.display_name AS created_by_name
         FROM hrd_rooms r LEFT JOIN users u ON u.id = r.created_by_user_id WHERE r.id = ?`,
      [req.params.id],
    );
    if (!room) return res.status(404).json({ error: 'Room not found.' });
    const [files] = await pool.query(
      `SELECT f.id, f.file_name, f.mime_type, f.size_bytes, f.created_at,
              u.display_name AS uploaded_by_name
         FROM hrd_room_files f
         LEFT JOIN users u ON u.id = f.uploaded_by_user_id
        WHERE f.room_id = ? ORDER BY f.created_at DESC, f.id DESC`,
      [req.params.id],
    );
    res.json({ ...room, files });
  } catch (err) { next(err); }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Room name is required.' });
    const [result] = await pool.query(
      'UPDATE hrd_rooms SET name = ?, description = ? WHERE id = ?',
      [name.slice(0, 150), String(req.body?.description || '').trim().slice(0, 5000) || null, req.params.id],
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Room not found.' });
    res.json({ id: Number(req.params.id), name });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A room with that name already exists.' });
    next(err);
  }
});

// Deleting a room takes its files with it, so a room that still holds files is refused until
// the caller confirms. A card gives no hint of how much is inside, and "delete" on a
// half-forgotten room should not quietly destroy a year of documents.
router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[room]] = await conn.query('SELECT id FROM hrd_rooms WHERE id = ?', [req.params.id]);
    if (!room) return res.status(404).json({ error: 'Room not found.' });
    const [[{ n }]] = await conn.query('SELECT COUNT(*) n FROM hrd_room_files WHERE room_id = ?', [req.params.id]);
    if (n > 0 && String(req.query.confirm) !== 'true') {
      return res.status(409).json({
        error: `This room holds ${n} file(s). Confirm to remove the room and everything in it.`,
        file_count: n,
      });
    }
    await conn.beginTransaction();
    await conn.query('DELETE FROM hrd_room_files WHERE room_id = ?', [req.params.id]);
    await conn.query('DELETE FROM hrd_rooms WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.json({ deleted: true, files_deleted: n });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// Any file type is accepted -- HR keeps scans, spreadsheets, photos and PDFs alike. The
// browser's reported type is stored only so the download can be served back with a sensible
// Content-Type; it is never trusted to decide anything.
router.post('/:id/files', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const [[room]] = await pool.query('SELECT id FROM hrd_rooms WHERE id = ?', [req.params.id]);
    if (!room) return res.status(404).json({ error: 'Room not found.' });

    const { file_name: fileName, data, mime_type: mimeType } = req.body || {};
    if (!fileName || !data) return res.status(400).json({ error: 'file_name and data are required.' });

    // Accepts a bare base64 string or a full data: URL, since the browser's FileReader hands
    // back the latter.
    const base64 = String(data).includes(',') ? String(data).split(',').pop() : String(data);
    let buf;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'data is not valid base64.' });
    }
    if (!buf.length) return res.status(400).json({ error: 'The uploaded file is empty.' });
    if (buf.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `Files must be ${MAX_UPLOAD_BYTES / 1024 / 1024}MB or smaller.` });
    }

    const safeMime = /^[\w.+-]+\/[\w.+-]+$/.test(String(mimeType || ''))
      ? String(mimeType).slice(0, 100)
      : 'application/octet-stream';

    const [result] = await pool.query(
      `INSERT INTO hrd_room_files (room_id, file_name, mime_type, size_bytes, file_data, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, String(fileName).slice(0, 255), safeMime, buf.length, buf, req.user.id],
    );
    const [[row]] = await pool.query(
      `SELECT f.id, f.file_name, f.mime_type, f.size_bytes, f.created_at, u.display_name AS uploaded_by_name
         FROM hrd_room_files f LEFT JOIN users u ON u.id = f.uploaded_by_user_id WHERE f.id = ?`,
      [result.insertId],
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.get('/:id/files/:fileId/file', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      'SELECT file_name, mime_type, file_data FROM hrd_room_files WHERE id = ? AND room_id = ?',
      [req.params.fileId, req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'File not found.' });
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    // PDFs and images open in a tab; anything the browser cannot render is offered as a
    // download rather than dumped into the page as text.
    const inline = /^(application\/pdf|image\/)/.test(row.mime_type || '');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${row.file_name.replace(/"/g, '')}"`);
    res.send(row.file_data);
  } catch (err) { next(err); }
});

router.delete('/:id/files/:fileId', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM hrd_room_files WHERE id = ? AND room_id = ?',
      [req.params.fileId, req.params.id],
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'File not found.' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
