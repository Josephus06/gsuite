// Who is signing in, by username or email (2026-11-24: several accounts may share one email --
// db/allow-shared-user-email.js). Taking the first row that matched was fine while emails were unique;
// with a shared one it could pick the wrong account, or say "invalid" to the right password.
//
//   1. An exact username match wins -- usernames are still unique.
//   2. Otherwise the accounts with that email: one -> it; several -> the one whose password matches;
//      if more than one has that password too, the person must sign in with their username.
//
// Returns { user } or { error: 'invalid' | 'ambiguous' }.
const bcrypt = require('bcryptjs');
const pool = require('../db');

async function findLoginUser(identifier, password, columns = 'id, username, email, password_hash') {
  const id = String(identifier || '').trim();
  if (!id || !password) return { error: 'invalid' };
  const [rows] = await pool.query(
    `SELECT ${columns} FROM users WHERE (username = ? OR email = ?) AND is_active = TRUE ORDER BY id`, [id, id]);
  if (!rows.length) return { error: 'invalid' };
  const byUsername = rows.filter((r) => String(r.username || '').toLowerCase() === id.toLowerCase());
  if (byUsername.length) {
    const u = byUsername[0];
    return (await bcrypt.compare(String(password), u.password_hash)) ? { user: u } : { error: 'invalid' };
  }
  const matches = [];
  for (const u of rows) {
    if (await bcrypt.compare(String(password), u.password_hash)) matches.push(u);
  }
  if (matches.length === 1) return { user: matches[0] };
  return { error: matches.length > 1 ? 'ambiguous' : 'invalid' };
}

const AMBIGUOUS_MESSAGE = 'More than one account uses this email. Sign in with your username instead.';

module.exports = { findLoginUser, AMBIGUOUS_MESSAGE };
