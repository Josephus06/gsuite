// Feed video uploads and playback (2026-10-13; lib/feedVideos.js). Mounted at /api/feed/videos,
// ahead of /api/feed, so these paths are never read as a post id.
//
//   POST /uploads              { file_name, size, mime_type } -> { id, chunk_bytes }
//   PUT  /uploads/:id/chunk?offset=N   raw bytes (application/octet-stream), up to chunk_bytes
//   GET  /uploads/:id          how much has arrived (to resume)
//   GET  /:id/url              a signed playback link, for whoever may see the post
//   GET  /:id/stream?t=...     the video, with Range -- no login header: the link is the pass
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { viewerContext, visiblePostsWhere } = require('../lib/feedData');
const fv = require('../lib/feedVideos');

const router = express.Router();

router.post('/uploads', requireAuth, async (req, res, next) => {
  try {
    const r = await fv.startUpload(req.user.id, req.body || {});
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.status(201).json(r);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'Video posts are not set up yet (db/add-feed-videos.js).' });
    next(err);
  }
});

router.get('/uploads/:id', requireAuth, async (req, res, next) => {
  try {
    const v = await fv.ownUpload(req.params.id, req.user.id);
    if (!v) return res.status(404).json({ error: 'Not found' });
    res.json({ id: v.id, received_bytes: Number(v.received_bytes), size_bytes: Number(v.size_bytes), status: v.status });
  } catch (err) { next(err); }
});

router.put('/uploads/:id/chunk', requireAuth, async (req, res, next) => {
  try {
    const v = await fv.ownUpload(req.params.id, req.user.id);
    if (!v) return res.status(404).json({ error: 'Not found' });
    const r = await fv.writeChunk(req, v);
    if (r.error) return res.status(r.status).json(r);
    res.json(r);
  } catch (err) {
    if (err.message === 'Upload interrupted') return undefined; // nobody is listening any more
    next(err);
  }
});

// A playback link for a video on a post the viewer may see -- or their own, not yet posted.
router.get('/:id/url', requireAuth, async (req, res, next) => {
  try {
    const [[v]] = await pool.query('SELECT id, user_id, post_id, status FROM feed_videos WHERE id = ?', [req.params.id]);
    if (!v || v.status !== 'ready') return res.status(404).json({ error: 'Not found' });
    let allowed = Number(v.user_id) === Number(req.user.id);
    if (!allowed && v.post_id) {
      const { groupId } = await viewerContext(req.user.id);
      const vis = visiblePostsWhere(req.user.id, groupId);
      const [[p]] = await pool.query(`SELECT p.id FROM feed_posts p WHERE p.id = ? AND ${vis.sql}`, [v.post_id, ...vis.params]);
      allowed = !!p;
    }
    if (!allowed) return res.status(404).json({ error: 'Not found' });
    res.json({ url: `/api/feed/videos/${v.id}/stream?t=${encodeURIComponent(fv.playbackToken(v.id))}` });
  } catch (err) { next(err); }
});

router.get('/:id/stream', async (req, res, next) => {
  try {
    if (!fv.tokenOk(Number(req.params.id), req.query.t)) return res.status(403).json({ error: 'This video link has expired. Reload the page.' });
    const [[v]] = await pool.query("SELECT id, storage_name, mime_type FROM feed_videos WHERE id = ? AND status = 'ready'", [req.params.id]);
    if (!v) return res.status(404).json({ error: 'Not found' });
    return fv.stream(req, res, v);
  } catch (err) { next(err); }
});

module.exports = router;
