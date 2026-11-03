// Sets a user's password from the server, for when nobody can sign in to change it in the app
// (asked 2026-11-03: "admin" read Invalid credentials). Matches the login: username OR email.
// Also says whether the account is inactive, the other reason the login refuses.
//
//   node src/db/reset-password.js admin                 # check the account only
//   node src/db/reset-password.js admin 'NewPassword'   # set it
// Office, cloud and SM replicate: run on ONE box (the cloud). Railway is separate: run it there too.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../db');

const [who, password] = process.argv.slice(2);

(async () => {
  if (!who) { console.error('Usage: node src/db/reset-password.js <username or email> [new password]'); process.exit(2); }
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [users] = await pool.query('SELECT id, username, email, display_name, is_active FROM users WHERE username = ? OR email = ?', [who, who]);
  if (!users.length) { console.log(`No user named "${who}".`); await pool.end(); return; }
  for (const u of users) console.log(`  #${u.id} ${u.username} <${u.email || ''}> ${u.display_name || ''} -- ${u.is_active ? 'active' : 'INACTIVE (cannot sign in)'}`);
  if (users.length > 1) { console.log('More than one match -- give the exact username.'); await pool.end(); return; }
  if (password) {
    await pool.query('UPDATE users SET password_hash = ?, is_active = TRUE WHERE id = ?', [await bcrypt.hash(password, 10), users[0].id]);
    console.log(`Password set for ${users[0].username}${users[0].is_active ? '' : ' (and the account made active)'}.`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
