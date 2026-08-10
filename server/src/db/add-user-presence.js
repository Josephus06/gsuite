// Adds users.last_seen_at, the heartbeat behind the feed's Contacts rail.
//
// last_login_at can't answer "is this person around right now": it only moves when someone
// authenticates, so an 8-hour session shows a stale login time all day, and a browser that
// never logged out looks logged-in forever. last_seen_at is touched by requireAuth on every
// authenticated request (throttled -- see middleware/auth.js) and cleared on logout, so
// "online" means actually using the app in the last few minutes.
const pool = require('../db');

async function columnExists(table, column) {
  const [r] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return r.length > 0;
}
async function indexExists(table, name) {
  const [r] = await pool.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name]);
  return r.length > 0;
}

async function main() {
  if (await columnExists('users', 'last_seen_at')) {
    console.log('  = users.last_seen_at already exists, skipping');
  } else {
    await pool.query('ALTER TABLE users ADD COLUMN last_seen_at DATETIME NULL AFTER last_login_at');
    console.log('  + added users.last_seen_at');
  }

  if (await indexExists('users', 'idx_users_last_seen')) {
    console.log('  = idx_users_last_seen already exists, skipping');
  } else {
    await pool.query('CREATE INDEX idx_users_last_seen ON users (last_seen_at)');
    console.log('  + added idx_users_last_seen');
  }

  console.log('\nDone.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
