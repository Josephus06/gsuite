// Company newsfeed: posts, 7-way reactions, and one-level comment threads.
//
// Audience is enforced here, never in the client -- visiblePostsWhere() is the single
// gate every read path goes through, so a post the viewer may not see is never serialized.
// See src/db/add-newsfeed.js for the schema and the audience model.
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const REACTIONS = ['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry'];
const AUDIENCES = ['public', 'department', 'private'];
const PAGE_SIZE = 10;
const MAX_BODY = 20000;
// A data-URL image lands in a MEDIUMTEXT (16 MB). The client downscales before sending;
// this is the backstop against a hand-rolled request filling the column.
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;
// How many comments ride along with each post in the feed payload. FB shows a couple and
// makes you click for the rest -- the client calls GET /:id/comments for the full thread.
const PREVIEW_COMMENTS = 2;
const PREVIEW_REACTORS = 3;

// The JWT carries only id/username/display_name, so department + admin come from a lookup.
async function viewerContext(userId) {
  const [[u]] = await pool.query(
    'SELECT user_group_id, account_type FROM users WHERE id = ?',
    [userId]
  );
  return {
    groupId: u?.user_group_id ?? null,
    isAdmin: u?.account_type === 'System Admin',
  };
}

// SQL fragment + params for "posts this viewer is allowed to read".
// A System Admin sees everything except other people's 'private' posts -- those stay private
// by design, since the audience picker promises "Only me".
function visiblePostsWhere(userId, groupId, alias = 'p') {
  const sql = `${alias}.is_deleted = 0 AND (
      ${alias}.audience = 'public'
      OR ${alias}.user_id = ?
      OR (${alias}.audience = 'department' AND ${alias}.audience_group_id IS NOT NULL AND ${alias}.audience_group_id = ?)
    )`;
  return { sql, params: [userId, groupId] };
}

const AUTHOR_COLS = `
  u.id            AS author_id,
  u.display_name  AS author_name,
  u.avatar_data   AS author_avatar,
  u.account_type  AS author_role,
  g.name          AS author_group`;

function shapePost(row, viewerId) {
  return {
    id: row.id,
    body: row.body || '',
    image_data: row.image_data || null,
    audience: row.audience,
    created_at: row.created_at,
    edited_at: row.edited_at,
    author: {
      id: row.author_id,
      display_name: row.author_name,
      avatar_data: row.author_avatar,
      account_type: row.author_role,
      group_name: row.author_group,
    },
    can_edit: Number(row.author_id) === Number(viewerId),
    reactions: {},
    reaction_total: 0,
    my_reaction: null,
    top_reactors: [],
    comment_count: 0,
    comments: [],
  };
}

function shapeComment(row, viewerId, isAdmin) {
  return {
    id: row.id,
    post_id: row.post_id,
    parent_comment_id: row.parent_comment_id,
    body: row.body,
    created_at: row.created_at,
    edited_at: row.edited_at,
    author: {
      id: row.author_id,
      display_name: row.author_name,
      avatar_data: row.author_avatar,
    },
    can_edit: Number(row.author_id) === Number(viewerId),
    can_delete: Number(row.author_id) === Number(viewerId) || isAdmin,
    reactions: {},
    reaction_total: 0,
    my_reaction: null,
    replies: [],
  };
}

// Fills reaction tallies, the viewer's own reaction, top reactor names, comment counts and
// preview comments onto an already-shaped page of posts. One query per concern for the whole
// page rather than per post -- the feed is 10 posts, but the same shape holds if that grows.
async function decoratePosts(posts, viewerId, isAdmin) {
  if (!posts.length) return posts;
  const ids = posts.map((p) => p.id);
  const byId = new Map(posts.map((p) => [Number(p.id), p]));

  const [tallies] = await pool.query(
    'SELECT post_id, type, COUNT(*) AS n FROM feed_post_reactions WHERE post_id IN (?) GROUP BY post_id, type',
    [ids]
  );
  for (const t of tallies) {
    const p = byId.get(Number(t.post_id));
    if (!p) continue;
    p.reactions[t.type] = Number(t.n);
    p.reaction_total += Number(t.n);
  }

  const [mine] = await pool.query(
    'SELECT post_id, type FROM feed_post_reactions WHERE post_id IN (?) AND user_id = ?',
    [ids, viewerId]
  );
  for (const m of mine) {
    const p = byId.get(Number(m.post_id));
    if (p) p.my_reaction = m.type;
  }

  // Names behind "Ana and 23 others" -- newest reactors first, capped per post.
  const [reactors] = await pool.query(
    `SELECT post_id, display_name FROM (
       SELECT r.post_id, u.display_name,
              ROW_NUMBER() OVER (PARTITION BY r.post_id ORDER BY r.created_at DESC, r.id DESC) AS rn
         FROM feed_post_reactions r JOIN users u ON u.id = r.user_id
        WHERE r.post_id IN (?)
     ) t WHERE rn <= ?`,
    [ids, PREVIEW_REACTORS]
  );
  for (const r of reactors) {
    const p = byId.get(Number(r.post_id));
    if (p) p.top_reactors.push(r.display_name);
  }

  const [counts] = await pool.query(
    'SELECT post_id, COUNT(*) AS n FROM feed_comments WHERE post_id IN (?) AND is_deleted = 0 GROUP BY post_id',
    [ids]
  );
  for (const c of counts) {
    const p = byId.get(Number(c.post_id));
    if (p) p.comment_count = Number(c.n);
  }

  // Preview = the newest few TOP-LEVEL comments, returned oldest-first so they read in order.
  const [preview] = await pool.query(
    `SELECT * FROM (
       SELECT c.id, c.post_id, c.parent_comment_id, c.body, c.created_at, c.edited_at,
              c.user_id AS author_id, u.display_name AS author_name, u.avatar_data AS author_avatar,
              ROW_NUMBER() OVER (PARTITION BY c.post_id ORDER BY c.created_at DESC, c.id DESC) AS rn
         FROM feed_comments c JOIN users u ON u.id = c.user_id
        WHERE c.post_id IN (?) AND c.is_deleted = 0 AND c.parent_comment_id IS NULL
     ) t WHERE rn <= ? ORDER BY created_at ASC, id ASC`,
    [ids, PREVIEW_COMMENTS]
  );
  const previewShaped = preview.map((r) => shapeComment(r, viewerId, isAdmin));
  await decorateComments(previewShaped, viewerId);
  for (const c of previewShaped) {
    const p = byId.get(Number(c.post_id));
    if (p) p.comments.push(c);
  }

  return posts;
}

async function decorateComments(comments, viewerId) {
  if (!comments.length) return comments;
  const ids = comments.map((c) => c.id);
  const byId = new Map(comments.map((c) => [Number(c.id), c]));

  const [tallies] = await pool.query(
    'SELECT comment_id, type, COUNT(*) AS n FROM feed_comment_reactions WHERE comment_id IN (?) GROUP BY comment_id, type',
    [ids]
  );
  for (const t of tallies) {
    const c = byId.get(Number(t.comment_id));
    if (!c) continue;
    c.reactions[t.type] = Number(t.n);
    c.reaction_total += Number(t.n);
  }

  const [mine] = await pool.query(
    'SELECT comment_id, type FROM feed_comment_reactions WHERE comment_id IN (?) AND user_id = ?',
    [ids, viewerId]
  );
  for (const m of mine) {
    const c = byId.get(Number(m.comment_id));
    if (c) c.my_reaction = m.type;
  }
  return comments;
}

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

async function notifyNewPost(post, author) {
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
// one row per reactor. Any UNREAD reaction notification for this post is replaced by a single
// refreshed one, so the author sees "Ana and 4 others reacted to your post". Already-read
// notifications are left alone -- those are history.
async function notifyReaction(post, actor) {
  if (Number(post.user_id) === Number(actor.id)) return;

  await pool.query(
    'DELETE FROM notifications WHERE user_id = ? AND type = ? AND related_type = ? AND related_id = ? AND is_read = 0',
    [post.user_id, NOTIFY.reaction, 'FeedPost', post.id]
  );

  const [[{ n }]] = await pool.query(
    'SELECT COUNT(*) AS n FROM feed_post_reactions WHERE post_id = ? AND user_id <> ?',
    [post.id, post.user_id]
  );
  const others = Math.max(0, n - 1);
  const who = others === 0
    ? actor.display_name
    : `${actor.display_name} and ${others} other${others === 1 ? '' : 's'}`;

  await insertNotifications([{
    userId: post.user_id,
    type: NOTIFY.reaction,
    title: `${who} reacted to your post`,
    message: post.body ? clip(post.body, 200) : 'Your photo',
    postId: post.id,
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

// Loads a post and asserts the viewer may read it. Returns null when missing or not visible --
// callers 404 either way so an invisible post is indistinguishable from a deleted one.
async function loadVisiblePost(postId, viewerId, groupId) {
  const vis = visiblePostsWhere(viewerId, groupId);
  const [[row]] = await pool.query(
    `SELECT p.* FROM feed_posts p WHERE p.id = ? AND ${vis.sql}`,
    [postId, ...vis.params]
  );
  return row || null;
}

// GET /api/feed?cursor=<lastId>  -- keyset pagination, newest first.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { groupId, isAdmin } = await viewerContext(req.user.id);
    const vis = visiblePostsWhere(req.user.id, groupId);
    const cursor = Number(req.query.cursor) || null;
    // The composer needs the viewer's department name to label the audience picker; it rides
    // along here so opening the composer costs no extra request.
    const [[group]] = groupId
      ? await pool.query('SELECT name FROM user_groups WHERE id = ?', [groupId])
      : [[null]];
    const limit = Math.min(Number(req.query.limit) || PAGE_SIZE, 50);

    const params = [...vis.params];
    let cursorSql = '';
    if (cursor) {
      cursorSql = ' AND p.id < ?';
      params.push(cursor);
    }

    const [rows] = await pool.query(
      `SELECT p.*, ${AUTHOR_COLS}
         FROM feed_posts p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN user_groups g ON g.id = u.user_group_id
        WHERE ${vis.sql}${cursorSql}
        ORDER BY p.id DESC
        LIMIT ?`,
      [...params, limit + 1]
    );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((r) => shapePost(r, req.user.id));
    await decoratePosts(page, req.user.id, isAdmin);

    res.json({
      posts: page,
      next_cursor: hasMore ? page[page.length - 1].id : null,
      viewer: { group_id: groupId, group_name: group?.name || null, is_admin: isAdmin },
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
const ONLINE_MINUTES = 5;

router.get('/contacts', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.display_name, u.avatar_data, u.account_type, g.name AS group_name,
              u.last_seen_at
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

// POST /api/feed  { body, image_data, audience }
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = (req.body.body || '').trim();
    const image = req.body.image_data || null;
    const audience = AUDIENCES.includes(req.body.audience) ? req.body.audience : 'public';

    if (!body && !image) return res.status(400).json({ error: 'Write something or add a photo.' });
    if (body.length > MAX_BODY) return res.status(400).json({ error: 'Post is too long.' });
    if (image && image.length > MAX_IMAGE_CHARS) return res.status(400).json({ error: 'Image is too large.' });

    const { groupId, isAdmin } = await viewerContext(req.user.id);
    if (audience === 'department' && !groupId) {
      return res.status(400).json({ error: 'You are not assigned to a department, so you cannot post to one.' });
    }

    const [result] = await pool.query(
      'INSERT INTO feed_posts (user_id, body, image_data, audience, audience_group_id) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, body || null, image, audience, audience === 'department' ? groupId : null]
    );

    const [[row]] = await pool.query(
      `SELECT p.*, ${AUTHOR_COLS}
         FROM feed_posts p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN user_groups g ON g.id = u.user_group_id
        WHERE p.id = ?`,
      [result.insertId]
    );
    const [post] = await decoratePosts([shapePost(row, req.user.id)], req.user.id, isAdmin);
    res.status(201).json({ post });

    // After the response: the poster shouldn't wait on a fan-out to every colleague.
    notifyNewPost(row, { id: req.user.id, display_name: req.user.display_name })
      .catch((e) => console.error('feed: new-post notify failed', e));
  } catch (err) {
    next(err);
  }
});

// PUT /api/feed/:id  -- author only.
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const [[existing]] = await pool.query('SELECT * FROM feed_posts WHERE id = ? AND is_deleted = 0', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Post not found' });
    if (Number(existing.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'You can only edit your own posts.' });
    }

    const body = (req.body.body ?? existing.body ?? '').trim();
    const hasImage = req.body.image_data !== undefined ? req.body.image_data : existing.image_data;
    if (!body && !hasImage) return res.status(400).json({ error: 'Write something or add a photo.' });
    if (body.length > MAX_BODY) return res.status(400).json({ error: 'Post is too long.' });

    const audience = AUDIENCES.includes(req.body.audience) ? req.body.audience : existing.audience;
    const { groupId, isAdmin } = await viewerContext(req.user.id);

    await pool.query(
      `UPDATE feed_posts
          SET body = ?, image_data = ?, audience = ?, audience_group_id = ?, edited_at = NOW()
        WHERE id = ?`,
      [
        body || null,
        req.body.image_data !== undefined ? req.body.image_data : existing.image_data,
        audience,
        audience === 'department' ? (existing.audience_group_id || groupId) : null,
        req.params.id,
      ]
    );

    const [[row]] = await pool.query(
      `SELECT p.*, ${AUTHOR_COLS}
         FROM feed_posts p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN user_groups g ON g.id = u.user_group_id
        WHERE p.id = ?`,
      [req.params.id]
    );
    const [post] = await decoratePosts([shapePost(row, req.user.id)], req.user.id, isAdmin);
    res.json({ post });
  } catch (err) {
    next(err);
  }
});

// Soft delete so comment threads and reaction history aren't destroyed by a stray click.
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const [[existing]] = await pool.query('SELECT * FROM feed_posts WHERE id = ? AND is_deleted = 0', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Post not found' });

    const { isAdmin } = await viewerContext(req.user.id);
    if (Number(existing.user_id) !== Number(req.user.id) && !isAdmin) {
      return res.status(403).json({ error: 'You can only delete your own posts.' });
    }

    await pool.query('UPDATE feed_posts SET is_deleted = 1 WHERE id = ?', [req.params.id]);
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
