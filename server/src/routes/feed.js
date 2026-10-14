// Company newsfeed: posts, 7-way reactions, and one-level comment threads.
//
// Audience is enforced server-side, never in the client. The gate and the row shaping live
// in lib/feedData.js because routes/profiles.js serves the same posts filtered to one author
// and must not carry a second copy of the rule. See src/db/add-newsfeed.js for the schema.
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const {
  REACTIONS,
  AUDIENCES,
  PAGE_SIZE,
  MAX_BODY,
  MAX_IMAGE_CHARS,
  MAX_IMAGES_PER_POST,
  POST_COLS,
  AUTHOR_COLS,
  POST_FROM,
  viewerContext,
  visiblePostsWhere,
  shapePost,
  shapeComment,
  decoratePosts,
  decorateComments,
  loadVisiblePost,
  fetchPostPage,
} = require('../lib/feedData');
const { checkAttach, setPostVideos, removeFiles, deletePostVideos } = require('../lib/feedVideos');

const router = express.Router();

/* ------------------------------------------------------------------ notifications ----
 * Feed events feed the same notifications table (and the same topnav bell) as the rest of
 * the app -- see routes/notifications.js. related_type is 'FeedPost' and related_id is the
 * post, so clicking any of them lands on that post.
 *
 * All of these are fire-and-forget: a notification failing must never fail the post, the
 * reaction or the comment that triggered it.
 */
const NOTIFY = {
  post: 'feed_post',
  reaction: 'feed_reaction',
  comment: 'feed_comment',
  reply: 'feed_reply',
};

const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function insertNotifications(rows) {
  if (!rows.length) return;
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, related_type, related_id) VALUES ?`,
    [rows.map((r) => [r.userId, r.type, clip(r.title, 255), clip(r.message, 500), 'FeedPost', r.postId])]
  );
}

// Which department a 'department' post is addressed to.
//
// Everyone else can only address their own, and the server does not take the client's word
// for which that is -- it reads it back off the user. A System Admin can address any
// department, which is the point: a notice meant for Production only should not have to go
// to the whole company or be re-posted by someone in Production.
//
// Returns { id } or { error, status } rather than throwing, because both callers have to turn
// a refusal into a reply the composer can show.
async function resolveAudienceGroup({ audience, requested, groupId, isAdmin }) {
  if (audience !== 'department') return { id: null };

  const wanted = Number(requested) || null;
  if (isAdmin && wanted) {
    const [[group]] = await pool.query('SELECT id FROM user_groups WHERE id = ?', [wanted]);
    if (!group) return { error: 'That department no longer exists.', status: 400 };
    return { id: group.id };
  }
  if (!groupId) {
    return { error: 'You are not assigned to a department, so you cannot post to one.', status: 400 };
  }
  if (wanted && wanted !== groupId) {
    return { error: 'You can only post to your own department.', status: 403 };
  }
  return { id: groupId };
}

// Everyone who should hear about a brand-new post: the same audience rule the feed query
// uses, minus the author. A 'private' post notifies nobody, which is the whole point of it.
async function recipientsForPost({ audience, groupId, authorId }) {
  if (audience === 'private') return [];
  const [rows] = audience === 'department'
    ? await pool.query(
      'SELECT id FROM users WHERE is_active = 1 AND id <> ? AND user_group_id = ?',
      [authorId, groupId]
    )
    : await pool.query('SELECT id FROM users WHERE is_active = 1 AND id <> ?', [authorId]);
  return rows.map((r) => r.id);
}

// A new post no longer notifies anyone (asked 2026-10-13: notify "only those who are involved").
// It reached the whole company -- or the whole department -- on every post, ~340 notifications a
// week for posts nobody was part of; the feed itself shows new posts. Reactions, comments and
// replies still reach the people they concern (below).
const NOTIFY_NEW_POSTS = false;

// A post for chosen people (audience 'custom', 2026-10-14). The people are the post's own audience,
// so they ARE involved: they are told, even though a general post tells nobody.
const MAX_AUDIENCE_USERS = 300;
async function readAudienceUsers(raw, authorId) {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter((id) => id && id !== Number(authorId)))];
  if (!ids.length) return { error: 'Choose at least one person to share this post with.' };
  if (ids.length > MAX_AUDIENCE_USERS) return { error: `A post can be shared with at most ${MAX_AUDIENCE_USERS} people.` };
  const [rows] = await pool.query('SELECT id FROM users WHERE id IN (?) AND is_active = 1', [ids]);
  return { ids: rows.map((r) => Number(r.id)) };
}
async function writeAudienceUsers(conn, postId, ids) {
  await conn.query('DELETE FROM feed_post_audience_users WHERE post_id = ?', [postId]);
  for (const id of ids) await conn.query('INSERT INTO feed_post_audience_users (post_id, user_id) VALUES (?, ?)', [postId, id]);
}

async function notifyNewPost(post, author, audienceIds = []) {
  if (post.audience === 'custom') {
    await insertNotifications(audienceIds.filter((id) => id !== Number(post.user_id)).map((userId) => ({
      userId,
      type: NOTIFY.post,
      title: `${author.display_name} shared a post with you`,
      message: post.body ? clip(post.body, 200) : 'Shared a photo',
      postId: post.id,
    })));
    return;
  }
  if (!NOTIFY_NEW_POSTS) return;
  const recipients = await recipientsForPost({
    audience: post.audience,
    groupId: post.audience_group_id,
    authorId: post.user_id,
  });
  await insertNotifications(recipients.map((userId) => ({
    userId,
    type: NOTIFY.post,
    title: `${author.display_name} shared a new post`,
    message: post.body ? clip(post.body, 200) : 'Shared a photo',
    postId: post.id,
  })));
}

// Reactions coalesce: repeated reacting (or a popular post) would otherwise bury the bell in
// one row per reactor. The author's UNREAD reaction notification for this post is REWRITTEN in
// place, so they see "Ana and 4 others reacted to your post". Already-read notifications are
// left alone -- those are history.
//
// Rewritten rather than deleted-and-reinserted, which is what it used to do. A DELETE issued
// from either half of the office/cloud pair can arrive at the other after that row has already
// gone, which stops replication with error 1032 and takes every other table down with it (see
// src/db/REPLICATION-RECOVERY.md). An UPDATE of a row both sides hold replicates cleanly, and
// an INSERT of a new row never conflicts because the two servers allocate ids from separate
// ranges.
async function notifyReaction(post, actor) {
  if (Number(post.user_id) === Number(actor.id)) return;

  const [[{ n }]] = await pool.query(
    'SELECT COUNT(*) AS n FROM feed_post_reactions WHERE post_id = ? AND user_id <> ?',
    [post.id, post.user_id]
  );
  const others = Math.max(0, n - 1);
  const who = others === 0
    ? actor.display_name
    : `${actor.display_name} and ${others} other${others === 1 ? '' : 's'}`;
  const title = `${who} reacted to your post`;
  const message = post.body ? clip(post.body, 200) : 'Your photo';

  // Newest first, one row: this coalesces onto a single notification going forward. Any extra
  // unread rows left over from the old delete-and-reinsert behaviour are simply outlived --
  // the bell's five-row cap clears them once read.
  const [updated] = await pool.query(
    `UPDATE notifications SET title = ?, message = ?, created_at = NOW()
      WHERE user_id = ? AND type = ? AND related_type = ? AND related_id = ? AND is_read = 0
      ORDER BY id DESC LIMIT 1`,
    [title, message, post.user_id, NOTIFY.reaction, 'FeedPost', post.id]
  );
  if (updated.affectedRows) return;

  await insertNotifications([{
    userId: post.user_id, type: NOTIFY.reaction, title, message, postId: post.id,
  }]);
}

// A comment notifies the post author; a reply also notifies the parent comment's author.
// Both are skipped for self-actions, and a single person is never notified twice for one
// comment (author replying under their own post, say).
async function notifyComment(post, actor, body, parentAuthorId) {
  const sent = new Set([Number(actor.id)]);
  const rows = [];

  if (!sent.has(Number(post.user_id))) {
    sent.add(Number(post.user_id));
    rows.push({
      userId: post.user_id,
      type: NOTIFY.comment,
      title: `${actor.display_name} commented on your post`,
      message: clip(body, 200),
      postId: post.id,
    });
  }

  if (parentAuthorId && !sent.has(Number(parentAuthorId))) {
    rows.push({
      userId: parentAuthorId,
      type: NOTIFY.reply,
      title: `${actor.display_name} replied to your comment`,
      message: clip(body, 200),
      postId: post.id,
    });
  }

  await insertNotifications(rows);
}

// GET /api/feed?cursor=<lastId>  -- keyset pagination, newest first.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { groupId, isAdmin } = await viewerContext(req.user.id);
    // The composer needs the viewer's department name to label the audience picker; it rides
    // along here so opening the composer costs no extra request.
    const [[group]] = groupId
      ? await pool.query('SELECT name FROM user_groups WHERE id = ?', [groupId])
      : [[null]];
    // Admins pick which department a post is for, so they get the list. Nobody else does --
    // an empty list is what makes the composer show the plain "My department" option, and
    // sending it to everyone would only advertise a choice the server would refuse.
    const [groups] = isAdmin
      ? await pool.query('SELECT id, name FROM user_groups ORDER BY name')
      : [[]];

    const { posts, nextCursor } = await fetchPostPage({
      viewerId: req.user.id,
      groupId,
      isAdmin,
      cursor: Number(req.query.cursor) || null,
      limit: Math.min(Number(req.query.limit) || PAGE_SIZE, 50),
    });

    res.json({
      posts,
      next_cursor: nextCursor,
      viewer: {
        group_id: groupId, group_name: group?.name || null, is_admin: isAdmin, groups,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Right-rail contact list -- only people actually around right now.
//
// "Around" is users.last_seen_at, the heartbeat requireAuth touches on each authenticated
// request (see middleware/auth.js) and logout clears. is_active alone is NOT presence: it is
// the account-enabled flag, so filtering on it would list every employee as permanently
// online. ONLINE_MINUTES has to exceed the middleware's 60s throttle or a user could be
// online yet have a heartbeat older than the window.
//
// Deliberately not behind requirePermission: every authenticated user already sees
// colleagues' names on posts, and gating the rail on an unrelated page permission would
// blank it for most accounts.
// One photo, as bytes. The feed used to inline every image as base64, which nothing could
// cache and everything had to wait for; served from here they arrive in parallel, after the
// posts are already on screen, and the browser keeps them.
//
// Visibility is re-checked through the post's own audience rule rather than trusted from the
// id -- an image id is a small integer, and a private post's photo must not be readable by
// anyone who increments one.
router.get('/images/:imageId', requireAuth, async (req, res, next) => {
  try {
    const { groupId } = await viewerContext(req.user.id);
    const vis = visiblePostsWhere(req.user.id, groupId);
    const [[row]] = await pool.query(
      `SELECT i.image_data FROM feed_post_images i
         JOIN feed_posts p ON p.id = i.post_id
        WHERE i.id = ? AND ${vis.sql}`,
      [req.params.imageId, ...vis.params],
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    // Stored as a data: URL ("data:image/jpeg;base64,...."), so the media type travels with
    // the bytes and does not have to be guessed from the filename -- there isn't one.
    const match = /^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/s.exec(row.image_data || '');
    const mime = match ? match[1] : 'application/octet-stream';
    const buf = Buffer.from(match ? match[2] : String(row.image_data || ''), 'base64');

    // A photo never changes once posted -- editing a post replaces the rows -- so this is
    // safe to cache hard. private, because the audience rule above decided who may see it and
    // a shared cache has no way to apply that.
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.setHeader('ETag', `"feedimg-${req.params.imageId}-${buf.length}"`);
    if (req.headers['if-none-match'] === res.getHeader('ETag')) return res.status(304).end();
    res.send(buf);
  } catch (err) { next(err); }
});

const ONLINE_MINUTES = 5;

router.get('/contacts', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.display_name, u.avatar_data, u.account_type, g.name AS group_name,
              u.last_seen_at,
              -- Whether they have Chat (routes/chat.js), so clicking them opens a chatbox.
              (u.account_type = 'System Admin' OR EXISTS (
                 SELECT 1 FROM user_page_permissions upp JOIN pages p ON p.id = upp.page_id
                  WHERE upp.user_id = u.id AND p.route = '/chat' AND upp.can_view = TRUE)) AS can_chat
         FROM users u
         LEFT JOIN user_groups g ON g.id = u.user_group_id
        WHERE u.is_active = 1
          AND u.id <> ?
          AND u.last_seen_at IS NOT NULL
          AND u.last_seen_at >= NOW() - INTERVAL ? MINUTE
        ORDER BY u.last_seen_at DESC, u.display_name ASC
        LIMIT 50`,
      [req.user.id, ONLINE_MINUTES]
    );
    res.json({ contacts: rows, online_window_minutes: ONLINE_MINUTES });
  } catch (err) {
    next(err);
  }
});

// Accepts either shape: images[] from the current client, or a lone image_data from one
// still running the previous bundle. Returns the photos in the order they should display,
// or throws the message the caller should hand back.
function readImages(reqBody) {
  const raw = Array.isArray(reqBody.images)
    ? reqBody.images
    : (reqBody.image_data ? [reqBody.image_data] : []);
  const images = raw.filter((i) => typeof i === 'string' && i.trim());
  if (images.length > MAX_IMAGES_PER_POST) {
    throw new Error(`A post can have at most ${MAX_IMAGES_PER_POST} photos.`);
  }
  if (images.some((i) => !i.startsWith('data:image/'))) throw new Error('That is not an image.');
  if (images.some((i) => i.length > MAX_IMAGE_CHARS)) throw new Error('Image is too large.');
  return images;
}

// Rewrites a post's photo list wholesale. Editing a post sends the list the author ended
// up with, so replacing is both simpler and more correct than diffing: a photo removed in
// the composer has to disappear here, and reordering has to stick.
async function writeImages(conn, postId, images) {
  await conn.query('DELETE FROM feed_post_images WHERE post_id = ?', [postId]);
  for (const [position, image] of images.entries()) {
    await conn.query(
      'INSERT INTO feed_post_images (post_id, position, image_data) VALUES (?, ?, ?)',
      [postId, position, image],
    );
  }
}

// POST /api/feed  { body, images[], audience }
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = (req.body.body || '').trim();
    let images;
    try { images = readImages(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    const audience = AUDIENCES.includes(req.body.audience) ? req.body.audience : 'public';
    // An uploaded video (2026-10-13; routes/feedVideos.js), by id.
    const vids = await checkAttach(req.user.id, req.body.video_ids);
    if (vids.error) return res.status(400).json({ error: vids.error });

    if (!body && !images.length && !vids.ids.length) return res.status(400).json({ error: 'Write something or add a photo or video.' });
    if (body.length > MAX_BODY) return res.status(400).json({ error: 'Post is too long.' });

    const { groupId, isAdmin } = await viewerContext(req.user.id);
    const target = await resolveAudienceGroup({
      audience, requested: req.body.audience_group_id, groupId, isAdmin,
    });
    if (target.error) return res.status(target.status).json({ error: target.error });
    let people = { ids: [] };
    if (audience === 'custom') {
      people = await readAudienceUsers(req.body.audience_user_ids, req.user.id);
      if (people.error) return res.status(400).json({ error: people.error });
    }

    // One transaction: a post whose photos failed to insert would show up in the feed as an
    // empty card, and the author has no way to tell it happened.
    const conn = await pool.getConnection();
    let postId;
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        'INSERT INTO feed_posts (user_id, body, audience, audience_group_id) VALUES (?, ?, ?, ?)',
        [req.user.id, body || null, audience, target.id]
      );
      postId = result.insertId;
      if (audience === 'custom') await writeAudienceUsers(conn, postId, people.ids);
      await writeImages(conn, postId, images);
      if (vids.ids.length) await setPostVideos(conn, postId, vids.ids);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally { conn.release(); }

    const [[row]] = await pool.query(
      `SELECT ${POST_COLS}, ${AUTHOR_COLS} ${POST_FROM} WHERE p.id = ?`,
      [postId]
    );
    const [post] = await decoratePosts([shapePost(row, req.user.id)], req.user.id, isAdmin);
    res.status(201).json({ post });

    // After the response: the poster shouldn't wait on a fan-out to every colleague.
    notifyNewPost(row, { id: req.user.id, display_name: req.user.display_name }, people.ids)
      .catch((e) => console.error('feed: new-post notify failed', e));
  } catch (err) {
    next(err);
  }
});

// PUT /api/feed/:id  -- author only.
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const [[existing]] = await pool.query(
      'SELECT id, user_id, body, audience, audience_group_id FROM feed_posts WHERE id = ? AND is_deleted = 0',
      [req.params.id],
    );
    if (!existing) return res.status(404).json({ error: 'Post not found' });
    if (Number(existing.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'You can only edit your own posts.' });
    }

    const body = (req.body.body ?? existing.body ?? '').trim();
    // An edit that mentions neither images nor image_data leaves the photos alone; one that
    // sends an empty list is the author having removed them all, which must be obeyed.
    const touchesImages = Array.isArray(req.body.images) || req.body.image_data !== undefined;
    let images = [];
    if (touchesImages) {
      try { images = readImages(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    } else {
      const [existingImages] = await pool.query(
        'SELECT image_data FROM feed_post_images WHERE post_id = ? ORDER BY position, id',
        [req.params.id],
      );
      images = existingImages.map((i) => i.image_data);
    }
    // Videos the same way: video_ids absent leaves them; a list (even empty) sets them.
    const touchesVideos = Array.isArray(req.body.video_ids);
    let videoIds = [];
    if (touchesVideos) {
      const vids = await checkAttach(req.user.id, req.body.video_ids, req.params.id);
      if (vids.error) return res.status(400).json({ error: vids.error });
      videoIds = vids.ids;
    } else {
      const [kept] = await pool.query('SELECT id FROM feed_videos WHERE post_id = ?', [req.params.id])
        .catch((e) => { if (e.code === 'ER_NO_SUCH_TABLE') return [[]]; throw e; });
      videoIds = kept.map((v) => Number(v.id));
    }
    if (!body && !images.length && !videoIds.length) return res.status(400).json({ error: 'Write something or add a photo or video.' });
    if (body.length > MAX_BODY) return res.status(400).json({ error: 'Post is too long.' });

    const audience = AUDIENCES.includes(req.body.audience) ? req.body.audience : existing.audience;
    const { groupId, isAdmin } = await viewerContext(req.user.id);
    // An edit that says nothing about the department keeps the one the post already had, so
    // fixing a typo on a post addressed to Production cannot quietly redirect it at the
    // author's own department.
    const target = await resolveAudienceGroup({
      audience,
      requested: req.body.audience_group_id ?? existing.audience_group_id,
      groupId,
      isAdmin,
    });
    if (target.error) return res.status(target.status).json({ error: target.error });
    // Chosen people (2026-10-14): a list sent replaces the post's; none sent keeps it -- unless the
    // post was not 'custom' before, when there is nothing to keep.
    let people = null;
    let before = [];
    if (existing.audience === 'custom') {
      const [rows] = await pool.query('SELECT user_id FROM feed_post_audience_users WHERE post_id = ?', [req.params.id]);
      before = rows.map((r) => Number(r.user_id));
    }
    if (audience === 'custom' && (Array.isArray(req.body.audience_user_ids) || existing.audience !== 'custom')) {
      people = await readAudienceUsers(req.body.audience_user_ids, existing.user_id);
      if (people.error) return res.status(400).json({ error: people.error });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE feed_posts
            SET body = ?, audience = ?, audience_group_id = ?, edited_at = NOW()
          WHERE id = ?`,
        [body || null, audience, target.id, req.params.id]
      );
      if (people) await writeAudienceUsers(conn, req.params.id, people.ids);
      else if (audience !== 'custom' && before.length) await conn.query('DELETE FROM feed_post_audience_users WHERE post_id = ?', [req.params.id]);
      if (touchesImages) await writeImages(conn, req.params.id, images);
      let droppedFiles = [];
      if (touchesVideos) droppedFiles = await setPostVideos(conn, req.params.id, videoIds);
      await conn.commit();
      await removeFiles(droppedFiles); // only once the rows are gone for good
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally { conn.release(); }

    const [[row]] = await pool.query(
      `SELECT ${POST_COLS}, ${AUTHOR_COLS} ${POST_FROM} WHERE p.id = ?`,
      [req.params.id]
    );
    const [post] = await decoratePosts([shapePost(row, req.user.id)], req.user.id, isAdmin);
    res.json({ post });

    // Someone newly added to a chosen-people post is told, as on a new one; those already on it
    // are not told again.
    if (people) {
      const added = people.ids.filter((id) => !before.includes(id));
      if (added.length) {
        notifyNewPost(row, { id: req.user.id, display_name: req.user.display_name }, added)
          .catch((e) => console.error('feed: shared-post notify failed', e));
      }
    }
  } catch (err) {
    next(err);
  }
});

// The audience picker's choices for "Specific people" (2026-10-14): everyone active, and the
// viewer's own group chats so a whole group can be added at once.
router.get('/audience-options', requireAuth, async (req, res, next) => {
  try {
    const [users] = await pool.query(
      'SELECT id, display_name, avatar_data FROM users WHERE is_active = 1 AND id <> ? ORDER BY display_name', [req.user.id]);
    let groups = [];
    try {
      const [g] = await pool.query(
        `SELECT g.id, g.name, GROUP_CONCAT(m2.user_id) AS member_ids
           FROM chat_groups g
           JOIN chat_group_members m ON m.group_id = g.id AND m.user_id = ?
           JOIN chat_group_members m2 ON m2.group_id = g.id
          GROUP BY g.id, g.name ORDER BY g.name`, [req.user.id]);
      groups = g.map((r) => ({ id: r.id, name: r.name, member_ids: String(r.member_ids || '').split(',').map(Number).filter(Boolean) }));
    } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
    res.json({ users, groups });
  } catch (err) { next(err); }
});

// Soft delete so comment threads and reaction history aren't destroyed by a stray click.
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const [[existing]] = await pool.query(
      'SELECT id, user_id FROM feed_posts WHERE id = ? AND is_deleted = 0',
      [req.params.id],
    );
    if (!existing) return res.status(404).json({ error: 'Post not found' });

    const { isAdmin } = await viewerContext(req.user.id);
    if (Number(existing.user_id) !== Number(req.user.id) && !isAdmin) {
      return res.status(403).json({ error: 'You can only delete your own posts.' });
    }

    await pool.query('UPDATE feed_posts SET is_deleted = 1 WHERE id = ?', [req.params.id]);
    // The post stays (soft-deleted) but its video goes -- gigabytes nobody can see any more.
    await deletePostVideos(req.params.id).catch((e) => console.error('feed: video delete failed', e.message));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/feed/:id/reaction  { type }  -- omit type (or send null) to clear.
router.put('/:id/reaction', requireAuth, async (req, res, next) => {
  try {
    const { groupId } = await viewerContext(req.user.id);
    const post = await loadVisiblePost(req.params.id, req.user.id, groupId);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const type = req.body.type;
    if (type == null) {
      await pool.query('DELETE FROM feed_post_reactions WHERE post_id = ? AND user_id = ?', [post.id, req.user.id]);
    } else {
      if (!REACTIONS.includes(type)) return res.status(400).json({ error: 'Unknown reaction' });
      await pool.query(
        `INSERT INTO feed_post_reactions (post_id, user_id, type) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE type = VALUES(type), created_at = NOW()`,
        [post.id, req.user.id, type]
      );
    }

    const [tallies] = await pool.query(
      'SELECT type, COUNT(*) AS n FROM feed_post_reactions WHERE post_id = ? GROUP BY type',
      [post.id]
    );
    const reactions = {};
    let total = 0;
    for (const t of tallies) { reactions[t.type] = Number(t.n); total += Number(t.n); }
    res.json({ reactions, reaction_total: total, my_reaction: type ?? null });

    // Only a new/changed reaction is worth a notification -- clearing one isn't an event.
    if (type != null) {
      notifyReaction(post, { id: req.user.id, display_name: req.user.display_name })
        .catch((e) => console.error('feed: reaction notify failed', e));
    }
  } catch (err) {
    next(err);
  }
});

// Everyone who reacted, for the tally popover.
router.get('/:id/reactions', requireAuth, async (req, res, next) => {
  try {
    const { groupId } = await viewerContext(req.user.id);
    const post = await loadVisiblePost(req.params.id, req.user.id, groupId);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const [rows] = await pool.query(
      `SELECT r.type, u.id, u.display_name, u.avatar_data
         FROM feed_post_reactions r JOIN users u ON u.id = r.user_id
        WHERE r.post_id = ? ORDER BY r.created_at DESC`,
      [post.id]
    );
    res.json({ reactors: rows });
  } catch (err) {
    next(err);
  }
});

// Full thread: top-level comments oldest-first, each with its replies nested one level.
router.get('/:id/comments', requireAuth, async (req, res, next) => {
  try {
    const { groupId, isAdmin } = await viewerContext(req.user.id);
    const post = await loadVisiblePost(req.params.id, req.user.id, groupId);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const [rows] = await pool.query(
      `SELECT c.id, c.post_id, c.parent_comment_id, c.body, c.created_at, c.edited_at,
              c.user_id AS author_id, u.display_name AS author_name, u.avatar_data AS author_avatar
         FROM feed_comments c JOIN users u ON u.id = c.user_id
        WHERE c.post_id = ? AND c.is_deleted = 0
        ORDER BY c.created_at ASC, c.id ASC`,
      [post.id]
    );

    const shaped = rows.map((r) => shapeComment(r, req.user.id, isAdmin));
    await decorateComments(shaped, req.user.id);

    const byId = new Map(shaped.map((c) => [Number(c.id), c]));
    const roots = [];
    for (const c of shaped) {
      const parent = c.parent_comment_id ? byId.get(Number(c.parent_comment_id)) : null;
      if (parent) parent.replies.push(c);
      else roots.push(c);
    }
    res.json({ comments: roots, total: shaped.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/feed/:id/comments  { body, parent_comment_id }
router.post('/:id/comments', requireAuth, async (req, res, next) => {
  try {
    const { groupId, isAdmin } = await viewerContext(req.user.id);
    const post = await loadVisiblePost(req.params.id, req.user.id, groupId);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const body = (req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
    if (body.length > MAX_BODY) return res.status(400).json({ error: 'Comment is too long.' });

    // Replies only nest one level: replying to a reply attaches to its parent, matching FB.
    let parentId = req.body.parent_comment_id || null;
    // Whoever wrote the comment being replied to -- notified alongside the post author.
    let parentAuthorId = null;
    if (parentId) {
      const [[parent]] = await pool.query(
        'SELECT id, post_id, parent_comment_id, user_id FROM feed_comments WHERE id = ? AND is_deleted = 0',
        [parentId]
      );
      if (!parent || Number(parent.post_id) !== Number(post.id)) {
        return res.status(400).json({ error: 'Parent comment not found on this post.' });
      }
      parentAuthorId = parent.user_id;
      parentId = parent.parent_comment_id || parent.id;
    }

    const [result] = await pool.query(
      'INSERT INTO feed_comments (post_id, parent_comment_id, user_id, body) VALUES (?, ?, ?, ?)',
      [post.id, parentId, req.user.id, body]
    );

    const [[row]] = await pool.query(
      `SELECT c.id, c.post_id, c.parent_comment_id, c.body, c.created_at, c.edited_at,
              c.user_id AS author_id, u.display_name AS author_name, u.avatar_data AS author_avatar
         FROM feed_comments c JOIN users u ON u.id = c.user_id
        WHERE c.id = ?`,
      [result.insertId]
    );

    const [[{ n }]] = await pool.query(
      'SELECT COUNT(*) AS n FROM feed_comments WHERE post_id = ? AND is_deleted = 0',
      [post.id]
    );
    res.status(201).json({ comment: shapeComment(row, req.user.id, isAdmin), comment_count: Number(n) });

    notifyComment(post, { id: req.user.id, display_name: req.user.display_name }, body, parentAuthorId)
      .catch((e) => console.error('feed: comment notify failed', e));
  } catch (err) {
    next(err);
  }
});

router.put('/comments/:commentId', requireAuth, async (req, res, next) => {
  try {
    const [[existing]] = await pool.query(
      'SELECT * FROM feed_comments WHERE id = ? AND is_deleted = 0',
      [req.params.commentId]
    );
    if (!existing) return res.status(404).json({ error: 'Comment not found' });
    if (Number(existing.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'You can only edit your own comments.' });
    }
    const body = (req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
    if (body.length > MAX_BODY) return res.status(400).json({ error: 'Comment is too long.' });

    await pool.query('UPDATE feed_comments SET body = ?, edited_at = NOW() WHERE id = ?', [body, existing.id]);
    res.json({ ok: true, body, edited_at: new Date() });
  } catch (err) {
    next(err);
  }
});

router.delete('/comments/:commentId', requireAuth, async (req, res, next) => {
  try {
    const [[existing]] = await pool.query(
      'SELECT * FROM feed_comments WHERE id = ? AND is_deleted = 0',
      [req.params.commentId]
    );
    if (!existing) return res.status(404).json({ error: 'Comment not found' });

    const { isAdmin } = await viewerContext(req.user.id);
    if (Number(existing.user_id) !== Number(req.user.id) && !isAdmin) {
      return res.status(403).json({ error: 'You can only delete your own comments.' });
    }

    // Cascades to replies: deleting a thread head shouldn't leave orphaned answers behind.
    await pool.query(
      'UPDATE feed_comments SET is_deleted = 1 WHERE id = ? OR parent_comment_id = ?',
      [existing.id, existing.id]
    );
    const [[{ n }]] = await pool.query(
      'SELECT COUNT(*) AS n FROM feed_comments WHERE post_id = ? AND is_deleted = 0',
      [existing.post_id]
    );
    res.json({ ok: true, comment_count: Number(n) });
  } catch (err) {
    next(err);
  }
});

router.put('/comments/:commentId/reaction', requireAuth, async (req, res, next) => {
  try {
    const [[existing]] = await pool.query(
      'SELECT * FROM feed_comments WHERE id = ? AND is_deleted = 0',
      [req.params.commentId]
    );
    if (!existing) return res.status(404).json({ error: 'Comment not found' });

    const { groupId } = await viewerContext(req.user.id);
    const post = await loadVisiblePost(existing.post_id, req.user.id, groupId);
    if (!post) return res.status(404).json({ error: 'Comment not found' });

    const type = req.body.type;
    if (type == null) {
      await pool.query('DELETE FROM feed_comment_reactions WHERE comment_id = ? AND user_id = ?', [existing.id, req.user.id]);
    } else {
      if (!REACTIONS.includes(type)) return res.status(400).json({ error: 'Unknown reaction' });
      await pool.query(
        `INSERT INTO feed_comment_reactions (comment_id, user_id, type) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE type = VALUES(type), created_at = NOW()`,
        [existing.id, req.user.id, type]
      );
    }

    const [tallies] = await pool.query(
      'SELECT type, COUNT(*) AS n FROM feed_comment_reactions WHERE comment_id = ? GROUP BY type',
      [existing.id]
    );
    const reactions = {};
    let total = 0;
    for (const t of tallies) { reactions[t.type] = Number(t.n); total += Number(t.n); }
    res.json({ reactions, reaction_total: total, my_reaction: type ?? null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
