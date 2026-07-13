const jwt = require('jsonwebtoken');
const pool = require('../db');

const PERMISSION_ACTIONS = new Set(['can_view', 'can_add', 'can_edit', 'can_delete', 'can_approve']);

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authorization token' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
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

module.exports = { requireAuth, requirePermission };
