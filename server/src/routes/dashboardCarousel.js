const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Everyone signed in can SEE the carousel -- it is company-wide notice material sitting beside
// the feed. Uploading is gated on can_add for the /dashboard page, so the right to post to it
// is granted in Users & Permissions like every other right, rather than being a second
// concept nobody remembers to check.
async function canUpload(userId) {
  const [[user]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [userId]);
  if (user?.account_type === 'System Admin') return true;
  const [[row]] = await pool.query(
    `SELECT p.can_add AS allowed
       FROM user_page_permissions p JOIN pages g ON g.id = p.page_id
      WHERE p.user_id = ? AND g.route = '/dashboard'`,
    [userId],
  );
  return !!row?.allowed;
}

// A short video is still tens of times the size of a photo, so the two have different
// ceilings. Both sit under the 14MB JSON body limit this route is given in index.js, which is
// what a 10MB file becomes once base64 inflates it by a third.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// 25MB of video is ~34MB once base64 inflates it, which is why this route gets its own
// oversized body parser in index.js. It is not raised further on purpose: every byte lives
// in the database, gets replicated to the office server, and rides in the nightly backup.
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

// Metadata only -- never the bytes. The rail renders <img>/<video> pointing at /:id/file, so a
// carousel of ten photos does not become ten megabytes of base64 in the dashboard payload.
// That is the same mistake the feed was making before it was fixed.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.id, m.media_type, m.mime_type, m.caption, m.file_name, m.size_bytes, m.created_at,
              u.display_name AS uploaded_by_name
         FROM dashboard_carousel_media m
         LEFT JOIN users u ON u.id = m.uploaded_by_user_id
        WHERE m.is_active = TRUE
        ORDER BY m.position, m.id DESC`,
    );
    res.json({ items: rows, can_upload: await canUpload(req.user.id) });
  } catch (err) { next(err); }
});

// Served with a long immutable cache: an item's bytes never change once uploaded -- editing
// means uploading a replacement -- so a browser should fetch each one exactly once.
router.get('/:id/file', requireAuth, async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      'SELECT mime_type, file_data, size_bytes FROM dashboard_carousel_media WHERE id = ? AND is_active = TRUE',
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    const etag = `"carousel-${req.params.id}-${row.size_bytes}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.setHeader('ETag', etag);
    // Videos are played, not downloaded, and a <video> element needs range support to seek.
    res.setHeader('Accept-Ranges', 'none');
    res.send(row.file_data);
  } catch (err) { next(err); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    if (!await canUpload(req.user.id)) {
      return res.status(403).json({ error: 'You do not have permission to post to the dashboard carousel.' });
    }
    const { data, mime_type: mimeType, file_name: fileName, caption } = req.body || {};
    if (!data) return res.status(400).json({ error: 'data is required.' });

    const mime = String(mimeType || '');
    const isImage = mime.startsWith('image/');
    const isVideo = mime.startsWith('video/');
    if (!isImage && !isVideo) {
      return res.status(400).json({ error: 'Only an image or a short video can go in the carousel.' });
    }

    const base64 = String(data).includes(',') ? String(data).split(',').pop() : String(data);
    let buf;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'data is not valid base64.' });
    }
    if (!buf.length) return res.status(400).json({ error: 'That file is empty.' });

    const limit = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (buf.length > limit) {
      return res.status(413).json({
        error: `${isVideo ? 'Videos' : 'Images'} must be ${limit / 1024 / 1024}MB or smaller — this one is ${(buf.length / 1024 / 1024).toFixed(1)}MB.`,
      });
    }

    // Appended to the end of the running order unless a position is given, so an upload never
    // silently jumps ahead of what is already there.
    const [[last]] = await pool.query('SELECT COALESCE(MAX(position), 0) AS p FROM dashboard_carousel_media');
    const [result] = await pool.query(
      `INSERT INTO dashboard_carousel_media
         (media_type, mime_type, file_name, caption, size_bytes, file_data, position, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        isVideo ? 'video' : 'image', mime.slice(0, 100), String(fileName || '').slice(0, 255) || null,
        String(caption || '').trim().slice(0, 255) || null, buf.length, buf, Number(last.p) + 1, req.user.id,
      ],
    );
    const [[row]] = await pool.query(
      'SELECT id, media_type, mime_type, caption, file_name, size_bytes, created_at FROM dashboard_carousel_media WHERE id = ?',
      [result.insertId],
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// A real DELETE, not a flag. Removing a clip is meant to reclaim the space: a hidden 25MB
// video would otherwise sit in the database forever, replicated to the office server and
// copied into every nightly backup, while being invisible to everyone.
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    if (!await canUpload(req.user.id)) {
      return res.status(403).json({ error: 'You do not have permission to change the dashboard carousel.' });
    }
    const [result] = await pool.query('DELETE FROM dashboard_carousel_media WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ removed: true });
  } catch (err) { next(err); }
});

module.exports = router;
