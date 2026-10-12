const express = require('express');
const { EventEmitter } = require('events');
const pool = require('../db');
const { requireAuth, userCan } = require('../middleware/auth');

const router = express.Router();

// Chat (2026-10-12): one-to-one messages, Messenger-style. See db/create-chat.js.
//
// Permission-based on /chat (view): a user without it gets nothing here, and cannot be messaged.
// Delivery is polled (GET /poll every few seconds, as the notification bell does) -- there is no
// socket server in this app, and a few seconds is what an office chat needs.
const ROUTE = '/chat';
const ONLINE_MINUTES = 5; // the newsfeed's Contacts rail uses the same window
const MAX_BODY = 4000;

const canChat = (userId) => userCan(userId, ROUTE, 'can_view');

// Long poll (see GET /poll): a waiting request is woken the moment a message for its user is saved
// through this server, and otherwise re-checks the table every RECHECK_MS for one saved through
// another server. LONG_POLL_MS stays well under the proxy's 60 s read timeout.
const LONG_POLL_MS = 25000;
const RECHECK_MS = 1000;
const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per waiting browser tab
const wake = (userId) => bus.emit(`u${userId}`);

// Typing (2026-10-12): someone counts as typing to me while their last key is under TYPING_TTL_MS
// old -- long enough to ride over a pause, short enough that a walked-away draft clears quickly.
const TYPING_TTL_MS = 5000;
// Seen (2026-10-12): for each of these people, the newest message I sent them that they have read
// (0 = none). One indexed lookup per open box -- at most a few.
async function seenBy(me, otherIds) {
  const out = {};
  for (const id of otherIds) {
    const [[r]] = await pool.query(
      `SELECT COALESCE(MAX(id), 0) AS seen FROM chat_messages
        WHERE sender_user_id = ? AND recipient_user_id = ? AND read_at IS NOT NULL`, [me, id]);
    out[id] = Number(r.seen) || 0;
  }
  return out;
}

async function typingTo(userId) {
  try {
    const [rows] = await pool.query(
      `SELECT user_id FROM chat_typing
        WHERE to_user_id = ? AND typed_at >= NOW(3) - INTERVAL ? MICROSECOND ORDER BY user_id`,
      [userId, TYPING_TTL_MS * 1000]);
    return rows.map((r) => Number(r.user_id));
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return []; // db/create-chat.js not re-run yet
    throw err;
  }
}
function waitForWake(userId, ms) {
  return new Promise((resolve) => {
    const ev = `u${userId}`;
    const done = () => { clearTimeout(timer); bus.off(ev, done); resolve(); };
    const timer = setTimeout(done, Math.max(0, ms));
    bus.on(ev, done);
  });
}

async function requireChat(req, res, next) {
  try {
    if (await canChat(req.user.id)) return next();
    return res.status(403).json({ error: 'Chat is not enabled for your account.' });
  } catch (err) { return next(err); }
}

// Everyone with the chat: System Admins and anyone given view on /chat, active, not me.
const CHATTERS_SQL = `
  SELECT u.id FROM users u
   WHERE u.is_active = 1 AND u.id <> ?
     AND (u.account_type = 'System Admin'
          OR EXISTS (SELECT 1 FROM user_page_permissions upp JOIN pages p ON p.id = upp.page_id
                      WHERE upp.user_id = u.id AND p.route = ? AND upp.can_view = TRUE))`;

// The people list: photo, name, online, unread from them, and when we last spoke -- the ones with
// something unread first, then the most recent conversations, then whoever is online, then by name.
router.get('/contacts', requireAuth, requireChat, async (req, res, next) => {
  try {
    const me = req.user.id;
    const [rows] = await pool.query(
      `SELECT u.id, u.display_name, u.avatar_data, u.account_type, g.name AS group_name,
              (u.last_seen_at IS NOT NULL AND u.last_seen_at >= NOW() - INTERVAL ? MINUTE) AS online,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.sender_user_id = u.id AND m.recipient_user_id = ? AND m.read_at IS NULL) AS unread,
              (SELECT MAX(m.id) FROM chat_messages m
                WHERE (m.sender_user_id = u.id AND m.recipient_user_id = ?) OR (m.sender_user_id = ? AND m.recipient_user_id = u.id)) AS last_message_id
         FROM users u
         LEFT JOIN user_groups g ON g.id = u.user_group_id
        WHERE u.id IN (${CHATTERS_SQL})
        ORDER BY (unread > 0) DESC, last_message_id IS NULL, last_message_id DESC, online DESC, u.display_name`,
      [ONLINE_MINUTES, me, me, me, me, ROUTE]);
    res.json(rows.map((r) => ({ ...r, online: !!r.online, unread: Number(r.unread) || 0 })));
  } catch (err) { next(err); }
});

// New messages to or from me since `after` (a message id). Called with no `after` it only says
// where "now" is, so a page load does not replay history as if it had just arrived. Each message
// carries the other person's name and photo, so a box can open for someone not yet on screen.
router.get('/poll', requireAuth, requireChat, async (req, res, next) => {
  try {
    const me = req.user.id;
    // Only a MISSING `after` means "first load". 0 is a real position -- someone with no messages
    // yet -- and reading it as a first load again would never deliver them anything.
    const first = req.query.after === undefined || req.query.after === '';
    const after = Math.max(0, Number(req.query.after) || 0);
    const [[{ unread }]] = await pool.query(
      'SELECT COUNT(*) AS unread FROM chat_messages WHERE recipient_user_id = ? AND read_at IS NULL', [me]);
    if (first) {
      const [[{ last }]] = await pool.query(
        'SELECT COALESCE(MAX(id), 0) AS last FROM chat_messages WHERE recipient_user_id = ? OR sender_user_id = ?', [me, me]);
      // The people with unread messages, so their boxes can open on load.
      const [pending] = await pool.query(
        `SELECT DISTINCT m.sender_user_id AS id, u.display_name, u.avatar_data
           FROM chat_messages m JOIN users u ON u.id = m.sender_user_id
          WHERE m.recipient_user_id = ? AND m.read_at IS NULL`, [me]);
      return res.json({ last_id: Number(last), messages: [], unread: Number(unread), pending });
    }
    const fetchNew = async () => (await pool.query(
      `SELECT m.id, m.sender_user_id, m.recipient_user_id, m.body, m.created_at, m.read_at,
              o.id AS other_id, o.display_name AS other_name, o.avatar_data AS other_avatar
         FROM chat_messages m
         JOIN users o ON o.id = IF(m.sender_user_id = ?, m.recipient_user_id, m.sender_user_id)
        WHERE m.id > ? AND (m.recipient_user_id = ? OR m.sender_user_id = ?)
        ORDER BY m.id LIMIT 200`, [me, after, me, me]))[0];

    // LONG POLL (?wait=1; 2026-10-12 -- a 4-second poll made every message up to 4 seconds late).
    // Nothing new yet: hold the request until something is, up to LONG_POLL_MS. A message sent
    // through THIS server wakes it at once (bus); one sent through another server (cloud / office /
    // SM, joined by replication) is caught by re-checking the table every RECHECK_MS. Given up early
    // if the browser goes away, so a closed tab does not keep checking.
    // Typing: the browser says who it already shows as typing (?typing=3,7); the wait also ends
    // the moment that changes -- someone starts, or stops (no key for TYPING_TTL_MS).
    const known = String(req.query.typing || '').split(',').map(Number).filter(Boolean).sort((a, b) => a - b).join(',');
    // Seen: for each open box (?open=3,7) the newest of my messages that person has read; the
    // browser sends what it shows (?seen=3:120,7:88) and the wait also ends when that moves.
    const openIds = String(req.query.open || '').split(',').map(Number).filter(Boolean).slice(0, 10);
    const knownSeen = String(req.query.seen || '');
    const seenSig = (m) => openIds.map((id) => `${id}:${m[id] || 0}`).join(',');
    let messages = await fetchNew();
    let typing = await typingTo(me);
    let seen = await seenBy(me, openIds);
    const unchanged = () => !messages.length && typing.join(',') === known && seenSig(seen) === knownSeen;
    if (unchanged() && req.query.wait === '1') {
      let gone = false;
      res.on('close', () => { if (!res.writableEnded) gone = true; });
      const deadline = Date.now() + LONG_POLL_MS;
      while (unchanged() && !gone && Date.now() < deadline) {
        await waitForWake(me, Math.min(RECHECK_MS, deadline - Date.now()));
        if (gone) return undefined;
        messages = await fetchNew();
        typing = await typingTo(me);
        seen = await seenBy(me, openIds);
      }
      if (gone) return undefined;
    }
    const [[{ unread: unreadNow }]] = messages.length
      ? await pool.query('SELECT COUNT(*) AS unread FROM chat_messages WHERE recipient_user_id = ? AND read_at IS NULL', [me])
      : [[{ unread }]];
    const lastId = messages.length ? messages[messages.length - 1].id : after;
    return res.json({ last_id: lastId, messages, unread: Number(unreadNow), typing, seen });
  } catch (err) { return next(err); }
});

// "I am typing to X" -- the box sends it at most every couple of seconds while a draft is being
// typed. Wakes X's waiting poll on this server; X on another server sees it at its next re-check.
router.post('/typing', requireAuth, requireChat, async (req, res, next) => {
  try {
    const to = Number(req.body.to);
    if (!to || to === req.user.id) return res.json({ ok: true });
    await pool.query(
      `INSERT INTO chat_typing (user_id, to_user_id, typed_at) VALUES (?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE typed_at = NOW(3)`, [req.user.id, to]);
    wake(to);
    return res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json({ ok: true }); // db/create-chat.js not re-run yet
    return next(err);
  }
});

// One conversation, newest 50 (or the 50 before `before`), oldest first.
router.get('/thread/:userId', requireAuth, requireChat, async (req, res, next) => {
  try {
    const me = req.user.id;
    const other = Number(req.params.userId);
    const before = Number(req.query.before) || null;
    const [rows] = await pool.query(
      `SELECT id, sender_user_id, recipient_user_id, body, created_at, read_at FROM chat_messages
        WHERE ((sender_user_id = ? AND recipient_user_id = ?) OR (sender_user_id = ? AND recipient_user_id = ?))
          ${before ? 'AND id < ?' : ''}
        ORDER BY id DESC LIMIT 50`,
      before ? [me, other, other, me, before] : [me, other, other, me]);
    const [[u]] = await pool.query(
      `SELECT id, display_name, avatar_data, (last_seen_at IS NOT NULL AND last_seen_at >= NOW() - INTERVAL ? MINUTE) AS online
         FROM users WHERE id = ?`, [ONLINE_MINUTES, other]);
    res.json({ user: u ? { ...u, online: !!u.online } : null, messages: rows.reverse(), has_more: rows.length === 50 });
  } catch (err) { next(err); }
});

router.post('/send', requireAuth, requireChat, async (req, res, next) => {
  try {
    const me = req.user.id;
    const to = Number(req.body.to);
    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Type a message.' });
    if (body.length > MAX_BODY) return res.status(400).json({ error: `A message can be at most ${MAX_BODY} characters.` });
    if (!to || to === me) return res.status(400).json({ error: 'Choose who to message.' });
    const [[u]] = await pool.query('SELECT id, is_active FROM users WHERE id = ?', [to]);
    if (!u || !u.is_active) return res.status(404).json({ error: 'That user is not available.' });
    if (!(await canChat(to))) return res.status(403).json({ error: 'That user does not have Chat.' });
    const [r] = await pool.query('INSERT INTO chat_messages (sender_user_id, recipient_user_id, body) VALUES (?, ?, ?)', [me, to, body]);
    // Sent: no longer typing to them.
    await pool.query('DELETE FROM chat_typing WHERE user_id = ? AND to_user_id = ?', [me, to]).catch(() => {});
    // Deliver now to anyone waiting on this server -- the recipient, and the sender's other tabs.
    wake(to); wake(me);
    const [[row]] = await pool.query(
      'SELECT id, sender_user_id, recipient_user_id, body, created_at, read_at FROM chat_messages WHERE id = ?', [r.insertId]);
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// Everything this person sent me is read -- the box is open and in front of me.
router.post('/read/:userId', requireAuth, requireChat, async (req, res, next) => {
  try {
    const [r] = await pool.query(
      'UPDATE chat_messages SET read_at = NOW() WHERE sender_user_id = ? AND recipient_user_id = ? AND read_at IS NULL',
      [Number(req.params.userId), req.user.id]);
    // The sender's box shows "Seen" now (on this server; another server's catches it on re-check).
    if (r.affectedRows) wake(Number(req.params.userId));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
