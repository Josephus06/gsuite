const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// The bell holds the five most recent notifications, read or unread.
//
// Read ones stay, so a notification can be looked at again after it has been opened -- but
// only the newest five are kept, and it is the read ones that make way. A sixth arriving
// pushes out the oldest one already dealt with.
//
// Nothing unread is ever deleted to make room. If the five newest are all unread, an older
// read one is still cleared, and beyond that the list is allowed to run past five rather than
// silently destroying something the user has never seen -- an unread ticket assignment
// disappearing before anyone laid eyes on it is a far worse outcome than a list of six.
const KEEP = 5;

// Applied when the list is read rather than at each of the twenty places that create a
// notification: every user polls this endpoint every five seconds, so the trim lands within a
// tick of the new arrival, and there is one rule in one place instead of twenty call sites
// that would each have to remember.
async function trim(userId) {
  await pool.query(
    `DELETE FROM notifications
      WHERE user_id = ? AND is_read = TRUE
        AND id NOT IN (
          SELECT id FROM (
            SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?
          ) newest
        )`,
    [userId, userId, KEEP],
  );
}

// Own notifications only, most recent first.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    await trim(req.user.id);
    const [rows] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50',
      [req.user.id]
    );
    const [[{ count }]] = await pool.query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = FALSE',
      [req.user.id]
    );
    res.json({ notifications: rows, unread_count: count });
  } catch (err) {
    next(err);
  }
});

// Marks it read; it stays in the list until a newer notification pushes it out.
router.put('/:id/read', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.put('/read-all', requireAuth, async (req, res, next) => {
  try {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND is_read = FALSE', [req.user.id]);
    // Clearing the badge is usually what pushes the list past five, so the trim runs here too
    // instead of leaving a long list on screen until the next poll.
    await trim(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
