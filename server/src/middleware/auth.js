const jwt = require('jsonwebtoken');
const pool = require('../db');

const PERMISSION_ACTIONS = new Set(['can_view', 'can_add', 'can_edit', 'can_delete', 'can_approve']);

// Presence heartbeat for the newsfeed's Contacts rail. Every authenticated request would be
// one UPDATE per request, which is far more writes than "who's online" is worth -- so each
// user's row is touched at most once a minute, tracked in-process. A restart just means one
// extra write per active user.
const PRESENCE_THROTTLE_MS = 60_000;
const lastTouched = new Map();

function touchPresence(userId) {
  const now = Date.now();
  const prev = lastTouched.get(userId);
  if (prev && now - prev < PRESENCE_THROTTLE_MS) return;
  lastTouched.set(userId, now);
  // Fire-and-forget: presence is never worth failing or delaying a real request over.
  pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = ?', [userId]).catch(() => {});
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authorization token' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    touchPresence(payload.id);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Called on logout so someone who signs out drops off the Contacts rail immediately rather
// than lingering for the length of the online window.
function clearPresence(userId) {
  lastTouched.delete(userId);
  return pool.query('UPDATE users SET last_seen_at = NULL WHERE id = ?', [userId]);
}

// Checks user_page_permissions for the given route + action ('can_view' | 'can_add' | 'can_edit' | 'can_delete' | 'can_approve')
function requirePermission(route, action = 'can_view') {
  if (!PERMISSION_ACTIONS.has(action)) {
    throw new Error(`Unknown permission action: ${action}`);
  }

  return async (req, res, next) => {
    try {
      const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
      if (!page) return res.status(500).json({ error: `Page not registered: ${route}` });

      const [[perm]] = await pool.query(
        `SELECT ${action} AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?`,
        [req.user.id, page.id]
      );

      if (!perm || !perm.allowed) {
        return res.status(403).json({ error: 'You do not have permission to perform this action' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireAuth, requirePermission, clearPresence };
