const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db');

// Sales > 3D Studio: a link that signs the user straight into the Signage Studio (the 3D design
// system on the office server).
//
//   STUDIO_WEB_URL=http://192.168.0.175:8080    what the user's browser opens
//   STUDIO_SSO_SECRET=<random, 32+ chars>       the same value as T1S_SSO_SECRET in the studio
//
// The token is HS256, valid two minutes, and the studio accepts each one once (jti). It names the
// T1S user; the studio creates the account on first use, as an Administrator for a T1S System
// Admin and with the sales menu (Dashboard, New Design, LED Studio, Production Drawings) for
// everyone else -- user, 2026-11-25.

const webUrl = () => String(process.env.STUDIO_WEB_URL || '').replace(/\/+$/, '');

async function signInUrl(userId) {
  const secret = process.env.STUDIO_SSO_SECRET || '';
  if (!webUrl() || secret.length < 32) return null;
  const [[u]] = await pool.query(
    'SELECT id, username, display_name, email, account_type, is_active FROM users WHERE id = ?', [userId]);
  if (!u || !u.is_active) return null;
  const token = jwt.sign(
    {
      sub: u.username,
      email: u.email || '',
      name: u.display_name || u.username,
      t1s_user_id: u.id,
      is_admin: u.account_type === 'System Admin',
    },
    secret,
    { algorithm: 'HS256', expiresIn: 120, issuer: 't1s', audience: 'signage-studio', jwtid: crypto.randomUUID() },
  );
  return `${webUrl()}/sso/t1s#token=${encodeURIComponent(token)}`;
}

module.exports = { signInUrl };
