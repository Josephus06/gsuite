// Feed videos (asked 2026-10-13; db/add-feed-videos.js): files up to 5 GB on the cloud server's disk.
//
// UPLOADED IN PIECES. nginx takes 40 MB a request and a 5 GB body would be one request held open for
// an hour, so the browser sends CHUNK_BYTES at a time to PUT /chunk; a dropped connection resumes from
// received_bytes instead of starting the whole file over.
//
// THE DISK IS THE DATABASE'S TOO. A full disk stops MySQL and with it the whole system, so an upload
// is refused up front when it would take videos past TOTAL_CAP_BYTES or leave less than MIN_FREE_BYTES
// free -- counting the full size of uploads still in progress, so two big ones at once cannot both pass.
//
// PLAYBACK goes through a signed link (GET /url, then /stream?t=...): a <video> element cannot send
// the login token, and the bytes are streamed with Range support so a viewer can start and seek
// without fetching 5 GB. The link is checked against the post's audience when it is handed out.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../db');

const GB = 1024 ** 3;
const MAX_VIDEO_BYTES = 5 * GB;
const CHUNK_BYTES = 8 * 1024 * 1024;
const TOTAL_CAP_BYTES = (Number(process.env.FEED_VIDEO_TOTAL_CAP_GB) || 40) * GB;
const MIN_FREE_BYTES = (Number(process.env.FEED_VIDEO_MIN_FREE_GB) || 20) * GB;
const LINK_SECONDS = 6 * 60 * 60; // a playback link lasts a long watch, not forever
const ABANDON_HOURS = 24; // an upload not finished in a day is cleared away
const MAX_VIDEOS_PER_POST = 1;

// Outside the app folder, so a deploy (git reset) can never touch it.
const DIR = process.env.FEED_VIDEO_DIR
  || (process.platform === 'win32' ? path.resolve(__dirname, '../../../media/feed-videos') : '/var/lib/gsuite/feed-videos');
const fileOf = (storageName) => path.join(DIR, `${storageName}.bin`);
const ensureDir = () => fs.promises.mkdir(DIR, { recursive: true });

const SECRET = () => process.env.FEED_VIDEO_SECRET || process.env.JWT_SECRET || 'feed-video';
const sign = (id, exp) => crypto.createHmac('sha256', SECRET()).update(`${id}.${exp}`).digest('base64url');

function playbackToken(id) {
  const exp = Math.floor(Date.now() / 1000) + LINK_SECONDS;
  return `${exp}.${sign(id, exp)}`;
}
function tokenOk(id, token) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const want = Buffer.from(sign(id, Number(exp)));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const isVideoMime = (m) => /^video\/[\w.+-]+$/.test(String(m || ''));

// Room for size more bytes? -> null, or the reason it does not fit.
async function roomFor(size) {
  const [[used]] = await pool.query(
    "SELECT COALESCE(SUM(CASE WHEN status = 'uploading' THEN size_bytes - received_bytes ELSE 0 END), 0) AS pending, COALESCE(SUM(received_bytes), 0) AS stored FROM feed_videos");
  const committed = Number(used.stored) + Number(used.pending);
  if (committed + size > TOTAL_CAP_BYTES) {
    return `Video storage is full (${(committed / GB).toFixed(1)} of ${TOTAL_CAP_BYTES / GB} GB used). Delete some older video posts, or ask the System Admin to raise the limit.`;
  }
  try {
    await ensureDir();
    const st = await fs.promises.statfs(DIR);
    const free = Number(st.bavail) * Number(st.bsize);
    if (free - Number(used.pending) - size < MIN_FREE_BYTES) {
      return 'The server does not have enough free disk space for this video right now.';
    }
  } catch { /* statfs unsupported: the cap above still holds */ }
  return null;
}

async function startUpload(userId, { file_name: fileName, size, mime_type: mime }) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return { status: 400, error: 'That file is empty.' };
  if (bytes > MAX_VIDEO_BYTES) return { status: 413, error: 'Videos must be 5 GB or smaller.' };
  if (!isVideoMime(mime)) return { status: 400, error: 'That is not a video file.' };
  const full = await roomFor(bytes);
  if (full) return { status: 507, error: full };
  await ensureDir();
  const storageName = crypto.randomBytes(16).toString('hex');
  await fs.promises.writeFile(fileOf(storageName), Buffer.alloc(0));
  const [r] = await pool.query(
    'INSERT INTO feed_videos (user_id, file_name, mime_type, size_bytes, storage_name) VALUES (?, ?, ?, ?, ?)',
    [userId, String(fileName || 'video').slice(0, 255), String(mime).slice(0, 100), bytes, storageName]);
  return { id: r.insertId, chunk_bytes: CHUNK_BYTES, received_bytes: 0 };
}

async function ownUpload(id, userId) {
  const [[v]] = await pool.query('SELECT * FROM feed_videos WHERE id = ? AND user_id = ?', [id, userId]);
  return v || null;
}

// One piece, appended at ?offset -- which must be exactly what has arrived so far, so a retried
// piece is never written twice. Streams the request body to the file; no parser holds it.
async function writeChunk(req, v) {
  const offset = Number(req.query.offset);
  if (v.status !== 'uploading') return { status: 409, error: 'This upload is already finished.' };
  if (offset !== Number(v.received_bytes)) return { status: 409, error: 'Out of order.', received_bytes: Number(v.received_bytes) };
  const remaining = Number(v.size_bytes) - offset;
  const limit = Math.min(CHUNK_BYTES, remaining);
  const file = fileOf(v.storage_name);
  // A piece that failed halfway may have left bytes past received_bytes; cut them off first.
  await fs.promises.truncate(file, offset);
  const out = fs.createWriteStream(file, { flags: 'a' });
  let n = 0;
  let tooBig = false;
  await new Promise((resolve, reject) => {
    req.on('data', (buf) => {
      n += buf.length;
      if (n > limit) { tooBig = true; req.unpipe(out); req.resume(); }
    });
    req.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    req.pipe(out);
    req.on('end', () => { if (tooBig) out.end(); });
    // The browser went away mid-piece: stop here; the next try truncates back to received_bytes.
    req.on('close', () => { if (!req.complete) { out.destroy(); reject(new Error('Upload interrupted')); } });
  });
  if (tooBig) {
    await fs.promises.truncate(file, offset);
    return { status: 413, error: 'Piece too large.' };
  }
  const received = offset + n;
  const done = received >= Number(v.size_bytes);
  await pool.query(
    `UPDATE feed_videos SET received_bytes = ?, status = ?, completed_at = ${done ? 'NOW()' : 'NULL'} WHERE id = ?`,
    [received, done ? 'ready' : 'uploading', v.id]);
  return { received_bytes: received, status: done ? 'ready' : 'uploading' };
}

// The videos a post may take: the poster's own, fully uploaded, not on another post.
async function checkAttach(userId, ids, postId = null) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))];
  if (list.length > MAX_VIDEOS_PER_POST) return { error: `A post can have ${MAX_VIDEOS_PER_POST} video.` };
  if (!list.length) return { ids: [] };
  const [rows] = await pool.query('SELECT id, user_id, post_id, status FROM feed_videos WHERE id IN (?)', [list]);
  for (const id of list) {
    const v = rows.find((r) => Number(r.id) === id);
    if (!v || Number(v.user_id) !== Number(userId)) return { error: 'That video was not found.' };
    if (v.status !== 'ready') return { error: 'The video is still uploading.' };
    if (v.post_id && Number(v.post_id) !== Number(postId)) return { error: 'That video is on another post.' };
  }
  return { ids: list };
}

// Set a post's videos to exactly `ids`; the ones it no longer uses are deleted with their files.
async function setPostVideos(conn, postId, ids) {
  const [old] = await conn.query('SELECT id, storage_name FROM feed_videos WHERE post_id = ?', [postId]);
  const dropped = old.filter((v) => !ids.includes(Number(v.id)));
  if (dropped.length) await conn.query('DELETE FROM feed_videos WHERE id IN (?)', [dropped.map((v) => v.id)]);
  if (ids.length) await conn.query('UPDATE feed_videos SET post_id = ? WHERE id IN (?)', [postId, ids]);
  return dropped.map((v) => v.storage_name);
}

async function removeFiles(storageNames) {
  for (const s of storageNames) await fs.promises.unlink(fileOf(s)).catch(() => {});
}

async function deletePostVideos(postId) {
  const [rows] = await pool.query('SELECT id, storage_name FROM feed_videos WHERE post_id = ?', [postId]);
  if (!rows.length) return;
  await pool.query('DELETE FROM feed_videos WHERE post_id = ?', [postId]);
  await removeFiles(rows.map((r) => r.storage_name));
}

// Posts' videos for the feed: ids and names only; the bytes come from /stream.
async function videosForPosts(postIds) {
  if (!postIds.length) return [];
  try {
    const [rows] = await pool.query(
      "SELECT id, post_id, file_name, mime_type, size_bytes FROM feed_videos WHERE post_id IN (?) AND status = 'ready' ORDER BY id", [postIds]);
    return rows;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return [];
    throw e;
  }
}

// GET .../stream: the file, honouring Range so the player can seek.
async function stream(req, res, v) {
  const file = fileOf(v.storage_name);
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return res.status(404).json({ error: 'Video file not found on this server.' }); }
  const size = stat.size;
  res.setHeader('Content-Type', v.mime_type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: pass it through, do not spool 5 GB to its temp dir
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m) {
    let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
    let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : size - 1;
    if (m[1] === '') end = size - 1;
    if (!(start >= 0 && start < size && end >= start)) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    end = Math.min(end, size - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', size);
  return fs.createReadStream(file).pipe(res);
}

// Uploads abandoned partway (and videos uploaded but never posted) are cleared after a day.
// Only the ones whose FILE is on this server: the rows replicate to the office box but the files
// do not, and two servers deleting the same rows would collide in replication.
async function sweepAbandoned() {
  try {
    const [found] = await pool.query(
      `SELECT id, storage_name FROM feed_videos
        WHERE post_id IS NULL AND created_at < NOW() - INTERVAL ? HOUR`, [ABANDON_HOURS]);
    const rows = [];
    for (const r of found) {
      if (await fs.promises.stat(fileOf(r.storage_name)).then(() => true, () => false)) rows.push(r);
    }
    if (!rows.length) return;
    await pool.query('DELETE FROM feed_videos WHERE id IN (?)', [rows.map((r) => r.id)]);
    await removeFiles(rows.map((r) => r.storage_name));
    console.log(`Feed videos: ${rows.length} unfinished or unposted upload(s) cleared.`);
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') console.error('Feed video sweep failed:', e.message);
  }
}
function scheduleFeedVideoSweep() {
  setTimeout(sweepAbandoned, 60 * 1000).unref();
  setInterval(sweepAbandoned, 60 * 60 * 1000).unref();
}

module.exports = {
  MAX_VIDEO_BYTES, CHUNK_BYTES, playbackToken, tokenOk, startUpload, ownUpload, writeChunk, checkAttach,
  setPostVideos, removeFiles, deletePostVideos, videosForPosts, stream, scheduleFeedVideoSweep,
};
