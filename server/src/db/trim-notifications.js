// Applies the five-notification cap to the existing backlog.
//
// The bell keeps the five most recent notifications per user and drops read ones older than
// that (see routes/notifications.js). New arrivals trim themselves as people poll, but the
// rows already in the table would only be cleared for whoever happens to open the app, so
// this does the whole lot in one pass.
//
// Unread notifications are never deleted, however old they are -- the same rule the endpoint
// follows. Someone who has not looked at the app in a month keeps everything waiting on them.
//
// Idempotent -- safe to re-run:
//   node src/db/trim-notifications.js
require('dotenv').config();
const pool = require('../db');

const KEEP = 5;

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [[before]] = await pool.query(
    'SELECT COUNT(*) AS total, SUM(is_read = TRUE) AS read_rows FROM notifications',
  );
  console.log(`  ${before.total} notification(s), ${Number(before.read_rows) || 0} read.`);

  const [users] = await pool.query(
    'SELECT user_id, COUNT(*) AS n FROM notifications GROUP BY user_id HAVING n > ?',
    [KEEP],
  );
  console.log(`  ${users.length} user(s) holding more than ${KEEP}.`);

  let removed = 0;
  // One user at a time rather than a single statement across the table: the cap is per user,
  // and a query that has to rank every row by user is far heavier than a few hundred small
  // deletes against the user_id index.
  for (const { user_id: userId } of users) {
    const [result] = await pool.query(
      `DELETE FROM notifications
        WHERE user_id = ? AND is_read = TRUE
          AND id NOT IN (
            SELECT id FROM (
              SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?
            ) newest
          )`,
      [userId, userId, KEEP],
    );
    removed += result.affectedRows;
  }

  const [[after]] = await pool.query('SELECT COUNT(*) AS total FROM notifications');
  const [over] = await pool.query(
    'SELECT user_id, COUNT(*) AS n FROM notifications GROUP BY user_id HAVING n > ?',
    [KEEP],
  );
  console.log(`  ${removed} read notification(s) deleted.`);
  // Anyone still over the cap is over it entirely on unread rows, which is the intended
  // outcome rather than a failure -- reported so the number is never a surprise.
  if (over.length) {
    console.log(`  ${over.length} user(s) still above ${KEEP}, all unread: `
      + over.map((u) => `${u.user_id}:${u.n}`).join(', '));
  }
  console.log(`Done. ${after.total} notification(s) left.`);
  await pool.end();
}

main().catch((err) => { console.error('Trim failed:', err); process.exit(1); });
