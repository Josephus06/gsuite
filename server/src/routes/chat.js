const express = require('express');
const { EventEmitter } = require('events');
const pool = require('../db');
const { requireAuth, userCan } = require('../middleware/auth');
const { REACTIONS, TABLE, decorate, messageAccess, readFiles, saveFiles, noTable: mediaNoTable } = require('../lib/chatMedia');

// What changed since ?rev (reactions, unsends) in my conversations and groups -- delivered over the
// poll so everyone sees them live (2026-10-13).
async function revUpdates(me, rev) {
  if (!rev) return { dm: [], group: [] };
  try {
    const [dm] = await pool.query(
      `SELECT m.id, m.sender_user_id, m.recipient_user_id, m.body, m.created_at, m.read_at, m.reply_to_id, m.unsent_at,
              IF(m.sender_user_id = ?, m.recipient_user_id, m.sender_user_id) AS other_id
         FROM chat_messages m WHERE m.rev_at > ? AND (m.sender_user_id = ? OR m.recipient_user_id = ?) ORDER BY m.rev_at LIMIT 200`,
      [me, rev, me, me]);
    const [group] = await pool.query(
      `SELECT m.id, m.group_id, m.sender_user_id, m.body, m.created_at, m.reply_to_id, m.unsent_at, u.display_name AS sender_name
         FROM chat_group_messages m JOIN chat_group_members gm ON gm.group_id = m.group_id AND gm.user_id = ?
         LEFT JOIN users u ON u.id = m.sender_user_id
        WHERE m.rev_at > ? ORDER BY m.rev_at LIMIT 200`, [me, rev]);
    return { dm, group };
  } catch (err) {
    if (mediaNoTable(err) || err.code === 'ER_NO_SUCH_TABLE') return { dm: [], group: [] };
    throw err;
  }
}

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
      // Group chats (2026-10-13): where "now" is in my groups, and the groups with something unread.
      const g = await groupPollStart(me);
      const [[{ now }]] = await pool.query('SELECT NOW(3) AS now');
      return res.json({ last_id: Number(last), messages: [], unread: Number(unread), pending, ...g, rev_now: now });
    }
    // Group messages since ?gafter, in groups I belong to.
    const gAfter = Math.max(0, Number(req.query.gafter) || 0);
    const fetchNewGroup = async () => (req.query.gafter === undefined ? [] : await newGroupMessages(me, gAfter));
    // Reactions / unsends since ?rev; the time this request started is where the next one picks up.
    const [[{ now: revNow }]] = await pool.query('SELECT NOW(3) AS now');
    const rev = req.query.rev ? String(req.query.rev) : null;
    const fetchUpdates = () => revUpdates(me, rev);
    const fetchNew = async () => (await pool.query(
      `SELECT m.id, m.sender_user_id, m.recipient_user_id, m.body, m.created_at, m.read_at, m.reply_to_id, m.unsent_at,
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
    let groupMessages = await fetchNewGroup();
    let updates = await fetchUpdates();
    let typing = await typingTo(me);
    let seen = await seenBy(me, openIds);
    const unchanged = () => !messages.length && !groupMessages.length && !updates.dm.length && !updates.group.length
      && typing.join(',') === known && seenSig(seen) === knownSeen;
    if (unchanged() && req.query.wait === '1') {
      let gone = false;
      res.on('close', () => { if (!res.writableEnded) gone = true; });
      const deadline = Date.now() + LONG_POLL_MS;
      while (unchanged() && !gone && Date.now() < deadline) {
        await waitForWake(me, Math.min(RECHECK_MS, deadline - Date.now()));
        if (gone) return undefined;
        messages = await fetchNew();
        groupMessages = await fetchNewGroup();
        updates = await fetchUpdates();
        typing = await typingTo(me);
        seen = await seenBy(me, openIds);
      }
      if (gone) return undefined;
    }
    const [[{ unread: unreadNow }]] = messages.length
      ? await pool.query('SELECT COUNT(*) AS unread FROM chat_messages WHERE recipient_user_id = ? AND read_at IS NULL', [me])
      : [[{ unread }]];
    const lastId = messages.length ? messages[messages.length - 1].id : after;
    const gLastId = groupMessages.length ? groupMessages[groupMessages.length - 1].id : gAfter;
    await decorate('dm', messages, me);
    await decorate('group', groupMessages, me);
    await decorate('dm', updates.dm, me);
    await decorate('group', updates.group, me);
    return res.json({
      last_id: lastId, messages, unread: Number(unreadNow), typing, seen, group_messages: groupMessages, g_last_id: gLastId,
      updates, rev_now: revNow,
    });
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
      `SELECT id, sender_user_id, recipient_user_id, body, created_at, read_at, reply_to_id, unsent_at FROM chat_messages
        WHERE ((sender_user_id = ? AND recipient_user_id = ?) OR (sender_user_id = ? AND recipient_user_id = ?))
          ${before ? 'AND id < ?' : ''}
        ORDER BY id DESC LIMIT 50`,
      before ? [me, other, other, me, before] : [me, other, other, me]);
    const [[u]] = await pool.query(
      `SELECT id, display_name, avatar_data, (last_seen_at IS NOT NULL AND last_seen_at >= NOW() - INTERVAL ? MINUTE) AS online
         FROM users WHERE id = ?`, [ONLINE_MINUTES, other]);
    await decorate('dm', rows, me);
    res.json({ user: u ? { ...u, online: !!u.online } : null, messages: rows.reverse(), has_more: rows.length === 50 });
  } catch (err) { next(err); }
});

router.post('/send', requireAuth, requireChat, async (req, res, next) => {
  try {
    const me = req.user.id;
    const to = Number(req.body.to);
    const body = String(req.body.body || '').trim();
    // Photos and files (2026-10-13): a message may be only those.
    const parsed = readFiles(req.body.attachments);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (!body && !parsed.files.length) return res.status(400).json({ error: 'Type a message.' });
    if (body.length > MAX_BODY) return res.status(400).json({ error: `A message can be at most ${MAX_BODY} characters.` });
    if (!to || to === me) return res.status(400).json({ error: 'Choose who to message.' });
    const [[u]] = await pool.query('SELECT id, is_active FROM users WHERE id = ?', [to]);
    if (!u || !u.is_active) return res.status(404).json({ error: 'That user is not available.' });
    if (!(await canChat(to))) return res.status(403).json({ error: 'That user does not have Chat.' });
    // A reply names a message of this same conversation.
    let replyTo = Number(req.body.reply_to_id) || null;
    if (replyTo) {
      const [[rm]] = await pool.query(
        `SELECT id FROM chat_messages WHERE id = ? AND ((sender_user_id = ? AND recipient_user_id = ?) OR (sender_user_id = ? AND recipient_user_id = ?))`,
        [replyTo, me, to, to, me]);
      if (!rm) replyTo = null;
    }
    const conn = await pool.getConnection();
    let r;
    try {
      await conn.beginTransaction();
      [r] = replyTo
        ? await conn.query('INSERT INTO chat_messages (sender_user_id, recipient_user_id, body, reply_to_id) VALUES (?, ?, ?, ?)', [me, to, body, replyTo])
        : await conn.query('INSERT INTO chat_messages (sender_user_id, recipient_user_id, body) VALUES (?, ?, ?)', [me, to, body]);
      await saveFiles(conn, 'dm', r.insertId, parsed.files);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    // Sent: no longer typing to them.
    await pool.query('DELETE FROM chat_typing WHERE user_id = ? AND to_user_id = ?', [me, to]).catch(() => {});
    // Deliver now to anyone waiting on this server -- the recipient, and the sender's other tabs.
    wake(to); wake(me);
    const [[row]] = await pool.query(
      'SELECT id, sender_user_id, recipient_user_id, body, created_at, read_at, reply_to_id, unsent_at FROM chat_messages WHERE id = ?', [r.insertId]);
    await decorate('dm', [row], me);
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

/* -------------------------------------------------------------------------- */
/* Group chats (2026-10-13; db/create-chat-groups.js)                          */
/* -------------------------------------------------------------------------- */
// Create a group: Can Add on Chat ("Create Group Chat"). Rename it and add or remove members: its
// creator only. Read and send: its members. Group messages are kept -- the nightly purge clears only
// one-to-one chat. Delivered through GET /poll like one-to-one messages (?gafter=).
const MAX_GROUP_NAME = 100;
const canCreateGroup = (userId) => userCan(userId, ROUTE, 'can_add');
const noTable = (err) => err && err.code === 'ER_NO_SUCH_TABLE';

async function groupPollStart(me) {
  try {
    const [[{ last }]] = await pool.query(
      `SELECT COALESCE(MAX(m.id), 0) AS last FROM chat_group_messages m
         JOIN chat_group_members gm ON gm.group_id = m.group_id AND gm.user_id = ?`, [me]);
    const [pending] = await pool.query(
      `SELECT g.id, g.name FROM chat_groups g JOIN chat_group_members gm ON gm.group_id = g.id AND gm.user_id = ?
        WHERE EXISTS (SELECT 1 FROM chat_group_messages m WHERE m.group_id = g.id AND m.id > gm.last_read_id AND m.sender_user_id <> ?)`,
      [me, me]);
    return { g_last_id: Number(last), pending_groups: pending };
  } catch (err) {
    if (noTable(err)) return { g_last_id: 0, pending_groups: [] };
    throw err;
  }
}

async function newGroupMessages(me, after) {
  try {
    const [rows] = await pool.query(
      `SELECT m.id, m.group_id, m.sender_user_id, m.body, m.created_at, m.reply_to_id, m.unsent_at, g.name AS group_name, u.display_name AS sender_name
         FROM chat_group_messages m
         JOIN chat_group_members gm ON gm.group_id = m.group_id AND gm.user_id = ?
         JOIN chat_groups g ON g.id = m.group_id
         LEFT JOIN users u ON u.id = m.sender_user_id
        WHERE m.id > ? ORDER BY m.id LIMIT 200`, [me, after]);
    return rows;
  } catch (err) {
    if (noTable(err)) return [];
    throw err;
  }
}

async function groupOf(groupId) {
  const [[g]] = await pool.query('SELECT id, name, created_by_user_id FROM chat_groups WHERE id = ?', [groupId]);
  return g || null;
}
async function memberIds(groupId) {
  const [rows] = await pool.query('SELECT user_id FROM chat_group_members WHERE group_id = ?', [groupId]);
  return rows.map((r) => Number(r.user_id));
}
// Only people who have Chat, are active, and exist.
async function validMembers(ids) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))];
  const ok = [];
  for (const id of clean) {
    const [[u]] = await pool.query('SELECT id FROM users WHERE id = ? AND is_active = 1', [id]);
    if (u && await canChat(id)) ok.push(id);
  }
  return ok;
}
// A group the user belongs to, or a 404/403 already sent.
async function memberGroup(req, res) {
  const g = await groupOf(Number(req.params.id));
  if (!g) { res.status(404).json({ error: 'Group not found.' }); return null; }
  const [[m]] = await pool.query('SELECT 1 AS x FROM chat_group_members WHERE group_id = ? AND user_id = ?', [g.id, req.user.id]);
  if (!m) { res.status(403).json({ error: 'You are not in this group.' }); return null; }
  return g;
}

// My groups, with unread counts; and whether I may create one.
router.get('/groups', requireAuth, requireChat, async (req, res, next) => {
  try {
    const me = req.user.id;
    const [groups] = await pool.query(
      `SELECT g.id, g.name, g.created_by_user_id, (g.created_by_user_id = ?) AS is_owner,
              (SELECT COUNT(*) FROM chat_group_members x WHERE x.group_id = g.id) AS member_count,
              (SELECT COUNT(*) FROM chat_group_messages m WHERE m.group_id = g.id AND m.id > gm.last_read_id AND m.sender_user_id <> ?) AS unread,
              (SELECT MAX(m.id) FROM chat_group_messages m WHERE m.group_id = g.id) AS last_message_id
         FROM chat_groups g JOIN chat_group_members gm ON gm.group_id = g.id AND gm.user_id = ?
        ORDER BY (unread > 0) DESC, last_message_id IS NULL, last_message_id DESC, g.name`, [me, me, me]);
    res.json({
      can_create: await canCreateGroup(me),
      groups: groups.map((g) => ({ ...g, is_owner: !!g.is_owner, unread: Number(g.unread) || 0, member_count: Number(g.member_count) })),
    });
  } catch (err) {
    if (noTable(err)) return res.json({ can_create: false, groups: [] });
    return next(err);
  }
});

router.post('/groups', requireAuth, requireChat, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const me = req.user.id;
    if (!(await canCreateGroup(me))) return res.status(403).json({ error: 'You do not have permission to create a group chat.' });
    const name = String(req.body.name || '').trim().slice(0, MAX_GROUP_NAME);
    if (!name) return res.status(400).json({ error: 'Give the group a name.' });
    const members = (await validMembers(req.body.member_ids)).filter((id) => id !== me);
    if (!members.length) return res.status(400).json({ error: 'Add at least one member.' });
    await conn.beginTransaction();
    const [r] = await conn.query('INSERT INTO chat_groups (name, created_by_user_id) VALUES (?, ?)', [name, me]);
    for (const id of [me, ...members]) await conn.query('INSERT INTO chat_group_members (group_id, user_id) VALUES (?, ?)', [r.insertId, id]);
    await conn.commit();
    [me, ...members].forEach((id) => wake(id));
    res.status(201).json({ id: r.insertId, name });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// A group's name and members.
router.get('/groups/:id', requireAuth, requireChat, async (req, res, next) => {
  try {
    const g = await memberGroup(req, res);
    if (!g) return undefined;
    const [members] = await pool.query(
      `SELECT u.id, u.display_name, u.avatar_data,
              (u.last_seen_at IS NOT NULL AND u.last_seen_at >= NOW() - INTERVAL ? MINUTE) AS online
         FROM chat_group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.display_name`,
      [ONLINE_MINUTES, g.id]);
    return res.json({
      id: g.id, name: g.name, created_by_user_id: g.created_by_user_id, is_owner: Number(g.created_by_user_id) === Number(req.user.id),
      members: members.map((m) => ({ ...m, online: !!m.online })),
    });
  } catch (err) { return next(err); }
});

// Rename and set the members -- the creator only. The creator always stays in.
router.put('/groups/:id', requireAuth, requireChat, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const g = await groupOf(Number(req.params.id));
    if (!g) return res.status(404).json({ error: 'Group not found.' });
    if (Number(g.created_by_user_id) !== Number(req.user.id)) return res.status(403).json({ error: 'Only the person who created this group can change it.' });
    const before = await memberIds(g.id);
    await conn.beginTransaction();
    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim().slice(0, MAX_GROUP_NAME);
      if (!name) { await conn.rollback(); return res.status(400).json({ error: 'Give the group a name.' }); }
      await conn.query('UPDATE chat_groups SET name = ? WHERE id = ?', [name, g.id]);
    }
    if (req.body.member_ids !== undefined) {
      const want = new Set([Number(g.created_by_user_id), ...(await validMembers(req.body.member_ids))]);
      for (const id of before) if (!want.has(id)) await conn.query('DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?', [g.id, id]);
      // A member added later reads from now on: earlier messages do not count as unread for them.
      const [[{ last }]] = await conn.query('SELECT COALESCE(MAX(id), 0) AS last FROM chat_group_messages WHERE group_id = ?', [g.id]);
      for (const id of want) if (!before.includes(id)) await conn.query('INSERT INTO chat_group_members (group_id, user_id, last_read_id) VALUES (?, ?, ?)', [g.id, id, last]);
    }
    await conn.commit();
    [...new Set([...before, ...(await memberIds(g.id))])].forEach((id) => wake(id));
    return res.json({ ok: true });
  } catch (err) { await conn.rollback(); return next(err); } finally { conn.release(); }
});

// Delete a group, its members and its messages -- the creator only.
router.delete('/groups/:id', requireAuth, requireChat, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const g = await groupOf(Number(req.params.id));
    if (!g) return res.status(404).json({ error: 'Group not found.' });
    if (Number(g.created_by_user_id) !== Number(req.user.id)) return res.status(403).json({ error: 'Only the person who created this group can delete it.' });
    const members = await memberIds(g.id);
    await conn.beginTransaction();
    await conn.query('DELETE FROM chat_group_messages WHERE group_id = ?', [g.id]);
    await conn.query('DELETE FROM chat_group_members WHERE group_id = ?', [g.id]);
    await conn.query('DELETE FROM chat_groups WHERE id = ?', [g.id]);
    await conn.commit();
    members.forEach((id) => wake(id));
    return res.status(204).send();
  } catch (err) { await conn.rollback(); return next(err); } finally { conn.release(); }
});

// Leave a group (not its creator, who deletes it instead).
router.post('/groups/:id/leave', requireAuth, requireChat, async (req, res, next) => {
  try {
    const g = await memberGroup(req, res);
    if (!g) return undefined;
    if (Number(g.created_by_user_id) === Number(req.user.id)) return res.status(409).json({ error: 'You created this group -- delete it instead of leaving.' });
    await pool.query('DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?', [g.id, req.user.id]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// A group's conversation, newest 50 (or the 50 before ?before), oldest first.
router.get('/groups/:id/thread', requireAuth, requireChat, async (req, res, next) => {
  try {
    const g = await memberGroup(req, res);
    if (!g) return undefined;
    const before = Number(req.query.before) || null;
    const [rows] = await pool.query(
      `SELECT m.id, m.group_id, m.sender_user_id, m.body, m.created_at, m.reply_to_id, m.unsent_at, u.display_name AS sender_name
         FROM chat_group_messages m LEFT JOIN users u ON u.id = m.sender_user_id
        WHERE m.group_id = ? ${before ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT 50`,
      before ? [g.id, before] : [g.id]);
    await decorate('group', rows, req.user.id);
    const [[me]] = await pool.query('SELECT last_read_id FROM chat_group_members WHERE group_id = ? AND user_id = ?', [g.id, req.user.id]);
    return res.json({
      group: { id: g.id, name: g.name, is_owner: Number(g.created_by_user_id) === Number(req.user.id), member_count: (await memberIds(g.id)).length },
      messages: rows.reverse(), has_more: rows.length === 50, last_read_id: Number(me?.last_read_id || 0),
    });
  } catch (err) { return next(err); }
});

router.post('/groups/:id/send', requireAuth, requireChat, async (req, res, next) => {
  try {
    const g = await memberGroup(req, res);
    if (!g) return undefined;
    const body = String(req.body.body || '').trim();
    const parsed = readFiles(req.body.attachments);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (!body && !parsed.files.length) return res.status(400).json({ error: 'Type a message.' });
    if (body.length > MAX_BODY) return res.status(400).json({ error: `A message can be at most ${MAX_BODY} characters.` });
    let replyTo = Number(req.body.reply_to_id) || null;
    if (replyTo) {
      const [[rm]] = await pool.query('SELECT id FROM chat_group_messages WHERE id = ? AND group_id = ?', [replyTo, g.id]);
      if (!rm) replyTo = null;
    }
    const conn = await pool.getConnection();
    let r;
    try {
      await conn.beginTransaction();
      [r] = replyTo
        ? await conn.query('INSERT INTO chat_group_messages (group_id, sender_user_id, body, reply_to_id) VALUES (?, ?, ?, ?)', [g.id, req.user.id, body, replyTo])
        : await conn.query('INSERT INTO chat_group_messages (group_id, sender_user_id, body) VALUES (?, ?, ?)', [g.id, req.user.id, body]);
      await saveFiles(conn, 'group', r.insertId, parsed.files);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    await pool.query('UPDATE chat_group_members SET last_read_id = ? WHERE group_id = ? AND user_id = ?', [r.insertId, g.id, req.user.id]);
    (await memberIds(g.id)).forEach((id) => wake(id));
    const [[row]] = await pool.query(
      `SELECT m.id, m.group_id, m.sender_user_id, m.body, m.created_at, m.reply_to_id, m.unsent_at, u.display_name AS sender_name
         FROM chat_group_messages m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.id = ?`, [r.insertId]);
    await decorate('group', [row], req.user.id);
    return res.status(201).json(row);
  } catch (err) { return next(err); }
});

// Everything in this group up to now is read by me.
router.post('/groups/:id/read', requireAuth, requireChat, async (req, res, next) => {
  try {
    const g = await memberGroup(req, res);
    if (!g) return undefined;
    await pool.query(
      `UPDATE chat_group_members SET last_read_id = (SELECT COALESCE(MAX(id), 0) FROM chat_group_messages WHERE group_id = ?)
        WHERE group_id = ? AND user_id = ?`, [g.id, g.id, req.user.id]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

/* -------------------------------------------------------------------------- */
/* Reactions, unsend, files (2026-10-13; lib/chatMedia.js)                     */
/* -------------------------------------------------------------------------- */
const kindOf = (v) => (v === 'group' ? 'group' : v === 'dm' ? 'dm' : null);

// React to a message -- one reaction per person; the same emoji again takes it off.
router.post('/react', requireAuth, requireChat, async (req, res, next) => {
  try {
    const kind = kindOf(req.body.kind);
    const id = Number(req.body.message_id);
    const emoji = req.body.emoji == null ? null : String(req.body.emoji);
    if (!kind || !id) return res.status(400).json({ error: 'Which message?' });
    if (emoji && !REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Not one of the reactions.' });
    const m = await messageAccess(kind, id, req.user.id);
    if (!m) return res.status(404).json({ error: 'Message not found.' });
    if (m.unsent_at) return res.status(409).json({ error: 'That message was unsent.' });
    const [[cur]] = await pool.query('SELECT emoji FROM chat_reactions WHERE kind = ? AND message_id = ? AND user_id = ?', [kind, id, req.user.id]);
    if (!emoji || (cur && cur.emoji === emoji)) {
      await pool.query('DELETE FROM chat_reactions WHERE kind = ? AND message_id = ? AND user_id = ?', [kind, id, req.user.id]);
    } else {
      await pool.query(
        `INSERT INTO chat_reactions (kind, message_id, user_id, emoji) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE emoji = VALUES(emoji), created_at = NOW(3)`, [kind, id, req.user.id, emoji]);
    }
    await pool.query(`UPDATE ${TABLE[kind]} SET rev_at = NOW(3) WHERE id = ?`, [id]);
    m.notify.forEach((u) => wake(u));
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// Unsend my own message: everyone sees "unsent"; its files are removed.
router.post('/unsend', requireAuth, requireChat, async (req, res, next) => {
  try {
    const kind = kindOf(req.body.kind);
    const id = Number(req.body.message_id);
    if (!kind || !id) return res.status(400).json({ error: 'Which message?' });
    const m = await messageAccess(kind, id, req.user.id);
    if (!m) return res.status(404).json({ error: 'Message not found.' });
    if (Number(m.sender_user_id) !== Number(req.user.id)) return res.status(403).json({ error: 'You can only unsend your own messages.' });
    await pool.query(`UPDATE ${TABLE[kind]} SET unsent_at = NOW(), body = '', rev_at = NOW(3) WHERE id = ?`, [id]);
    await pool.query('DELETE FROM chat_attachments WHERE kind = ? AND message_id = ?', [kind, id]);
    await pool.query('DELETE FROM chat_reactions WHERE kind = ? AND message_id = ?', [kind, id]);
    m.notify.forEach((u) => wake(u));
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// A photo or file sent in a chat -- to the people in that conversation only.
router.get('/attachments/:id', requireAuth, requireChat, async (req, res, next) => {
  try {
    const [[a]] = await pool.query('SELECT id, kind, message_id, file_name, mime_type, file_data FROM chat_attachments WHERE id = ?', [Number(req.params.id)]);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!(await messageAccess(a.kind, a.message_id, req.user.id))) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    const inline = /^(image\/|application\/pdf)/.test(a.mime_type || '') && req.query.download !== '1';
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${String(a.file_name).replace(/"/g, '')}"`);
    return res.send(a.file_data);
  } catch (err) { return next(err); }
});

module.exports = router;
