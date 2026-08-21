const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Reading a notification deletes it.
//
// The bell is a list of things still waiting on you, not a log. Kept as a log it only ever
// grew -- on the live database most of what it held was already-read rows nobody would look
// at again, and the one unread item that mattered sat somewhere below them. So a notification
// exists exactly as long as it is outstanding, and the list is empty when there is nothing
// left to act on.
//
// What that costs, deliberately: there is no going back to a notification once it has been
// opened. The thing it points at -- the ticket, the job order, the post -- is still there and
// is where the actual history lives; the notification was only ever the tap on the shoulder.

// Own notifications only, most recent first.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50',
      [req.user.id]
    );
    // Every row that still exists is unread, so this is a plain count. It is still a separate
    // query rather than rows.length because the list above is capped at 50 and the badge has
    // to be able to say 60.
    const [[{ count }]] = await pool.query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ?',
      [req.user.id]
    );
    res.json({ notifications: rows, unread_count: count });
  } catch (err) {
    next(err);
  }
});

// Kept at PUT /:id/read rather than becoming DELETE /:id: a browser still running the previous
// bundle calls this path, and having that quietly do the right thing is worth more than the
// verb being tidy.
router.put('/:id/read', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM notifications WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Clears the lot. Reading everything and deleting everything are now the same act, so this is
// the button that empties the bell.
router.put('/read-all', requireAuth, async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM notifications WHERE user_id = ?', [req.user.id]);
    res.json({ ok: true, cleared: result.affectedRows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
