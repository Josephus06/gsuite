// User profile pages: the About panel and a person's own posts.
//
// Almost everything in "About" is already in the ERP -- position and hire date from
// employees, department from user_groups, branch from locations -- so the only stored
// profile fields are the two the user writes themselves (bio, cover photo), added by
// src/db/add-user-profile.js.
//
// Post visibility reuses lib/feedData's audience gate rather than filtering to
// audience='public' here. Those are NOT the same rule: a colleague in your department
// should see your department posts on your profile, and you should see your own private
// posts on your own profile. Going through the shared gate keeps profile and feed
// consistent by construction.
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PAGE_SIZE, MAX_IMAGE_CHARS, viewerContext, fetchPostPage } = require('../lib/feedData');

const router = express.Router();

const MAX_BIO = 500;

// Everything the About panel shows, joined from where the ERP already keeps it.
const PROFILE_SQL = `
  SELECT u.id, u.display_name, u.username, u.email, u.bio, u.avatar_data, u.cover_data,
         u.account_type, u.created_at, u.last_seen_at, u.is_active,
         g.name        AS group_name,
         e.position_title, e.phone, e.date_hired, e.employee_code,
         e.email       AS work_email,
         l.location_name AS branch_name
    FROM users u
    LEFT JOIN user_groups g ON g.id = u.user_group_id
    LEFT JOIN employees e   ON e.id = u.employee_id
    LEFT JOIN locations l   ON l.id = u.default_branch_id
   WHERE u.id = ?`;

const ONLINE_MINUTES = 5;

function shapeProfile(row, viewerId) {
  const lastSeen = row.last_seen_at ? new Date(`${String(row.last_seen_at).replace(' ', 'T')}Z`) : null;
  return {
    id: row.id,
    display_name: row.display_name,
    username: row.username,
    bio: row.bio || '',
    avatar_data: row.avatar_data,
    cover_data: row.cover_data,
    is_active: !!row.is_active,
    is_self: Number(row.id) === Number(viewerId),
    is_online: !!lastSeen && Date.now() - lastSeen.getTime() < ONLINE_MINUTES * 60 * 1000,
    last_seen_at: row.last_seen_at,
    about: {
      position_title: row.position_title || null,
      account_type: row.account_type || null,
      group_name: row.group_name || null,
      branch_name: row.branch_name || null,
      email: row.work_email || row.email || null,
      phone: row.phone || null,
      employee_code: row.employee_code || null,
      date_hired: row.date_hired || null,
      member_since: row.created_at,
    },
  };
}

// GET /api/profiles/:id -- the header + About panel, plus how many posts the VIEWER can see.
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const [[row]] = await pool.query(PROFILE_SQL, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'User not found' });

    const { groupId } = await viewerContext(req.user.id);
    // Counted through the same audience rule as the listing below, so the tab label can
    // never promise more posts than the list will actually show.
    const [[{ n }]] = await pool.query(
      `SELECT COUNT(*) AS n FROM feed_posts p
        WHERE p.user_id = ? AND p.is_deleted = 0 AND (
          p.audience = 'public'
          OR p.user_id = ?
          OR (p.audience = 'department' AND p.audience_group_id IS NOT NULL AND p.audience_group_id = ?)
        )`,
      [req.params.id, req.user.id, groupId]
    );

    res.json({ profile: shapeProfile(row, req.user.id), post_count: Number(n) });
  } catch (err) {
    next(err);
  }
});

// GET /api/profiles/:id/posts?cursor= -- that person's posts, audience-filtered for the viewer.
router.get('/:id/posts', requireAuth, async (req, res, next) => {
  try {
    const [[exists]] = await pool.query('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!exists) return res.status(404).json({ error: 'User not found' });

    const { groupId, isAdmin } = await viewerContext(req.user.id);
    const { posts, nextCursor } = await fetchPostPage({
      viewerId: req.user.id,
      groupId,
      isAdmin,
      cursor: Number(req.query.cursor) || null,
      limit: Math.min(Number(req.query.limit) || PAGE_SIZE, 50),
      extraSql: ' AND p.user_id = ?',
      extraParams: [req.params.id],
    });

    res.json({ posts, next_cursor: nextCursor });
  } catch (err) {
    next(err);
  }
});

// PUT /api/profiles/me  { bio } -- self only; there is deliberately no way to edit someone
// else's bio, not even for an admin.
router.put('/me', requireAuth, async (req, res, next) => {
  try {
    const bio = String(req.body.bio ?? '').trim();
    if (bio.length > MAX_BIO) return res.status(400).json({ error: `Bio must be ${MAX_BIO} characters or fewer.` });

    await pool.query('UPDATE users SET bio = ? WHERE id = ?', [bio || null, req.user.id]);
    res.json({ ok: true, bio });
  } catch (err) {
    next(err);
  }
});

// PUT /api/profiles/me/cover  { cover_data } -- send null to remove the cover photo.
router.put('/me/cover', requireAuth, async (req, res, next) => {
  try {
    const cover = req.body.cover_data || null;
    if (cover && typeof cover !== 'string') return res.status(400).json({ error: 'Invalid image.' });
    if (cover && !cover.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image.' });
    if (cover && cover.length > MAX_IMAGE_CHARS) return res.status(400).json({ error: 'Image is too large.' });

    await pool.query('UPDATE users SET cover_data = ? WHERE id = ?', [cover, req.user.id]);
    res.json({ ok: true, cover_data: cover });
  } catch (err) {
    next(err);
  }
});

// ---- Personal site background -------------------------------------------------------
//
// The wallpaper a user sets for their own view of the app (topbar control, next to the
// Day/Night toggle). Private to that user, so there is deliberately no route to read
// anyone else's -- both handlers work off req.user.id and ignore any id in the request.
//
// Kept off GET /auth/me on purpose: that response is fetched on every page load and its
// user object is cached in localStorage, so hanging a megabyte-scale image on it would
// bloat both. The client fetches this once and caches the image under its own key.
const MAX_BG_CHARS = 1_500_000;

// GET /api/profiles/me/background -> { bg_data }
router.get('/me/background', requireAuth, async (req, res, next) => {
  try {
    const [[row]] = await pool.query('SELECT bg_data FROM users WHERE id = ?', [req.user.id]);
    res.json({ bg_data: row?.bg_data || null });
  } catch (err) {
    next(err);
  }
});

// PUT /api/profiles/me/background  { bg_data } -- send null to go back to the plain theme.
router.put('/me/background', requireAuth, async (req, res, next) => {
  try {
    const bg = req.body.bg_data || null;
    if (bg && typeof bg !== 'string') return res.status(400).json({ error: 'Invalid image.' });
    if (bg && !bg.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image.' });
    // Smaller than the feed's MAX_IMAGE_CHARS because this one has two extra ceilings to
    // clear: the 2mb express.json body limit these routes are mounted under, and the
    // browser's ~5mb localStorage quota, where the client caches it for a flash-free paint.
    if (bg && bg.length > MAX_BG_CHARS) return res.status(400).json({ error: 'Image is too large.' });

    await pool.query('UPDATE users SET bg_data = ? WHERE id = ?', [bg, req.user.id]);
    res.json({ ok: true, bg_data: bg });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
