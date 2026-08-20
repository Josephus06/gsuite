const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// A profile page exported at print resolution is a big image, but it is still one page of a
// brochure -- 8MB is generous for that and keeps a 24-page book under 200MB in the database,
// which is the number that matters since every byte replicates and lands in the backup.
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif)$/i;

// Viewing is open to anyone who can see the module; managing the artwork needs can_edit on
// /product, so it is granted in Users & Permissions like every other right rather than being
// a separate concept.
async function canManage(userId) {
  const [[user]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [userId]);
  if (user?.account_type === 'System Admin') return true;
  const [[row]] = await pool.query(
    `SELECT p.can_edit AS allowed
       FROM user_page_permissions p JOIN pages g ON g.id = p.page_id
      WHERE p.user_id = ? AND g.route = '/product'`,
    [userId],
  );
  return !!row?.allowed;
}

// Metadata only. The bytes come one page at a time from /:id/file, so opening the module does
// not pull an entire brochure before the first page can be drawn.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT f.id, f.position, f.slot, f.file_name, f.caption, f.mime_type, f.size_bytes, f.created_at,
              u.display_name AS uploaded_by_name
         FROM product_flipbook_pages f
         LEFT JOIN users u ON u.id = f.uploaded_by_user_id
        ORDER BY f.position, f.id`,
    );
    // Two different things live in this table. A row with no slot is a page of the book; a
    // slotted row is a photograph dropped into a frame on one of the built-in pages. They are
    // handed over separately so neither side has to filter the other out.
    const slots = {};
    for (const r of rows) if (r.slot) slots[r.slot] = r;
    res.json({
      pages: rows.filter((r) => !r.slot),
      slots,
      can_manage: await canManage(req.user.id),
    });
  } catch (err) { next(err); }
});

router.get('/:id/file', requireAuth, async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      'SELECT mime_type, file_data, size_bytes FROM product_flipbook_pages WHERE id = ?',
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    const etag = `"pfp-${req.params.id}-${row.size_bytes}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    // A page's bytes never change once uploaded -- replacing one means uploading another --
    // so this caches hard. Turning back and forth through the book costs nothing after the
    // first read.
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.setHeader('ETag', etag);
    res.send(row.file_data);
  } catch (err) { next(err); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    if (!await canManage(req.user.id)) {
      return res.status(403).json({ error: 'You do not have permission to change the product flipbook.' });
    }
    const { data, mime_type: mimeType, file_name: fileName, caption } = req.body || {};
    // Slot names come from the page definitions, not from the user, so they are a short
    // known-shape identifier rather than free text.
    const slot = /^[a-z0-9-]{1,40}$/.test(String(req.body?.slot || '')) ? String(req.body.slot) : null;
    if (!data) return res.status(400).json({ error: 'data is required.' });
    if (!IMAGE_TYPES.test(String(mimeType || ''))) {
      return res.status(400).json({ error: 'Flipbook pages must be images (PNG, JPG, WEBP or GIF).' });
    }

    const base64 = String(data).includes(',') ? String(data).split(',').pop() : String(data);
    let buf;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'data is not valid base64.' });
    }
    if (!buf.length) return res.status(400).json({ error: 'That file is empty.' });
    if (buf.length > MAX_PAGE_BYTES) {
      return res.status(413).json({
        error: `Pages must be ${MAX_PAGE_BYTES / 1024 / 1024}MB or smaller — this one is ${(buf.length / 1048576).toFixed(1)}MB.`,
      });
    }

    // A slot holds one photo, so uploading to a filled frame replaces what is there --
    // otherwise the only way to change a picture would be to delete it first, and a
    // half-finished replacement would leave the frame empty in the meantime.
    let position = 0;
    if (!slot) {
      // Appended to the end. A batch upload sends files in name order, so page-01..page-24
      // lands in reading order without anyone reordering afterwards.
      const [[last]] = await pool.query(
        'SELECT COALESCE(MAX(position), 0) AS p FROM product_flipbook_pages WHERE slot IS NULL',
      );
      position = Number(last.p) + 1;
    } else {
      await pool.query('DELETE FROM product_flipbook_pages WHERE slot = ?', [slot]);
    }

    const [result] = await pool.query(
      `INSERT INTO product_flipbook_pages (position, slot, file_name, caption, mime_type, size_bytes, file_data, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        position, slot, String(fileName || '').slice(0, 255) || null,
        String(caption || '').trim().slice(0, 255) || null,
        String(mimeType).slice(0, 100), buf.length, buf, req.user.id,
      ],
    );
    const [[row]] = await pool.query(
      'SELECT id, position, slot, file_name, caption, mime_type, size_bytes, created_at FROM product_flipbook_pages WHERE id = ?',
      [result.insertId],
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// Whole-order replacement rather than per-page nudges: moving one page changes the position of
// everything after it, and sending the full order is the only version that cannot drift out of
// step with what the manager is looking at.
router.put('/order', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    if (!await canManage(req.user.id)) {
      return res.status(403).json({ error: 'You do not have permission to change the product flipbook.' });
    }
    const ids = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];
    if (!ids.length) return res.status(400).json({ error: 'ids are required.' });

    await conn.beginTransaction();
    for (let i = 0; i < ids.length; i += 1) {
      await conn.query(
        'UPDATE product_flipbook_pages SET position = ? WHERE id = ? AND slot IS NULL',
        [i + 1, ids[i]],
      );
    }
    await conn.commit();
    res.json({ reordered: ids.length });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// A real delete: the point of removing a page is to reclaim its bytes, which otherwise keep
// replicating to the office server and riding in every nightly backup.
router.delete('/slot/:slot', requireAuth, async (req, res, next) => {
  try {
    if (!await canManage(req.user.id)) {
      return res.status(403).json({ error: 'You do not have permission to change the product flipbook.' });
    }
    const [result] = await pool.query('DELETE FROM product_flipbook_pages WHERE slot = ?', [req.params.slot]);
    if (!result.affectedRows) return res.status(404).json({ error: 'That frame is already empty.' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    if (!await canManage(req.user.id)) {
      return res.status(403).json({ error: 'You do not have permission to change the product flipbook.' });
    }
    const [result] = await pool.query('DELETE FROM product_flipbook_pages WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
