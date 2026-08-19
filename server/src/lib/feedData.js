// Shared newsfeed data access: the audience gate plus the row-shaping and decoration used to
// build a page of posts.
//
// This lives in a lib rather than in routes/feed.js because routes/profiles.js serves the
// same posts filtered to one author. Duplicating visiblePostsWhere() into a second route is
// the kind of thing that silently drifts and leaks a private post, so there is exactly one
// copy of the rule and both routes go through it.
const pool = require('../db');

const REACTIONS = ['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry'];
const AUDIENCES = ['public', 'department', 'private'];
const PAGE_SIZE = 10;
const MAX_BODY = 20000;
// A data-URL image lands in a MEDIUMTEXT (16 MB). The client downscales before sending;
// this is the backstop against a hand-rolled request filling the column.
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;
// Photos per post. High enough that nobody bumps into it posting an event or a site visit,
// low enough that one post cannot make the feed page enormous for everyone who scrolls
// past it -- every photo is inline base64 in the payload, not a URL the browser can skip.
const MAX_IMAGES_PER_POST = 10;
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

// Named columns rather than p.*, so the superseded feed_posts.image_data blob is not read
// on every page. Photos now come from feed_post_images via decoratePosts.
const POST_COLS = `
  p.id, p.user_id, p.body, p.audience, p.audience_group_id, p.created_at, p.edited_at`;

const AUTHOR_COLS = `
  u.id            AS author_id,
  u.display_name  AS author_name,
  u.avatar_data   AS author_avatar,
  u.account_type  AS author_role,
  g.name          AS author_group`;

// Every post read goes through this join, so the author block is always populated the same way.
const POST_FROM = `
  FROM feed_posts p
  JOIN users u ON u.id = p.user_id
  LEFT JOIN user_groups g ON g.id = u.user_group_id`;

function shapePost(row, viewerId) {
  return {
    id: row.id,
    body: row.body || '',
    // Filled by decoratePosts. image_data is kept alongside as the first photo purely so a
    // browser still running the previous bundle keeps showing something after a deploy; it
    // is derived from the same list, not read from the old column, so it costs no extra
    // bytes and cannot disagree with it.
    images: [],
    image_data: null,
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

  const [images] = await pool.query(
    `SELECT post_id, image_data FROM feed_post_images
      WHERE post_id IN (?) ORDER BY post_id, position, id`,
    [ids]
  );
  for (const img of images) {
    const post = byId.get(Number(img.post_id));
    if (!post) continue;
    post.images.push(img.image_data);
  }
  for (const post of posts) post.image_data = post.images[0] || null;

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

// Loads a post and asserts the viewer may read it. Returns null when missing or not visible --
// callers 404 either way so an invisible post is indistinguishable from a deleted one.
async function loadVisiblePost(postId, viewerId, groupId) {
  const vis = visiblePostsWhere(viewerId, groupId);
  const [[row]] = await pool.query(
    `SELECT ${POST_COLS} FROM feed_posts p WHERE p.id = ? AND ${vis.sql}`,
    [postId, ...vis.params]
  );
  return row || null;
}

// One page of posts, newest first, already decorated. `extraSql`/`extraParams` narrow the set
// further (profiles pass "and only by this author"); the audience gate always applies on top.
async function fetchPostPage({ viewerId, groupId, isAdmin, cursor, limit = PAGE_SIZE, extraSql = '', extraParams = [] }) {
  const vis = visiblePostsWhere(viewerId, groupId);
  const params = [...vis.params, ...extraParams];
  let cursorSql = '';
  if (cursor) {
    cursorSql = ' AND p.id < ?';
    params.push(cursor);
  }

  const [rows] = await pool.query(
    `SELECT ${POST_COLS}, ${AUTHOR_COLS} ${POST_FROM}
      WHERE ${vis.sql}${extraSql}${cursorSql}
      ORDER BY p.id DESC
      LIMIT ?`,
    [...params, limit + 1]
  );

  const hasMore = rows.length > limit;
  const posts = rows.slice(0, limit).map((r) => shapePost(r, viewerId));
  await decoratePosts(posts, viewerId, isAdmin);
  return { posts, nextCursor: hasMore ? posts[posts.length - 1].id : null };
}

module.exports = {
  REACTIONS,
  AUDIENCES,
  PAGE_SIZE,
  MAX_IMAGES_PER_POST,
  POST_COLS,
  MAX_BODY,
  MAX_IMAGE_CHARS,
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
};
