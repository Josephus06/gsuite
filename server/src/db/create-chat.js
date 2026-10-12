// Chat (asked 2026-10-12): one-to-one messages between users, Messenger-style -- a list of people
// on the Dashboard, a chatbox that pops out, and a message that opens the box on the other person's
// screen whatever page they are on (routes/chat.js, components/ChatDock.jsx).
//
// PERMISSION-BASED: the page /chat. Only a user with view on it (or a System Admin) has the chat at
// all, and only such users can be messaged -- grant it in Users & Permissions.
//
//   chat_messages   sender, recipient, body, sent at (to the millisecond, so a burst keeps its
//                   order), read at (NULL = unread). Indexed for "my new messages" and for one
//                   conversation's history.
//
// Who is online reads users.last_seen_at, the same heartbeat as the newsfeed's Contacts rail.
//
// Idempotent. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/create-chat.js
require('dotenv').config();
const pool = require('../db');

const ROUTE = '/chat';

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  // The users table's collation, so joins between the two never mix collations.
  const [[ref]] = await pool.query(
    "SELECT TABLE_COLLATION AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users'");
  const coll = ref?.c || 'utf8mb4_unicode_ci';
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      sender_user_id BIGINT NOT NULL,
      recipient_user_id BIGINT NOT NULL,
      body TEXT NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      read_at DATETIME NULL,
      KEY idx_chat_recipient_unread (recipient_user_id, read_at),
      KEY idx_chat_pair (sender_user_id, recipient_user_id, id)
    ) DEFAULT CHARSET=${coll.split('_')[0]} COLLATE=${coll}`);
  console.log('chat_messages ready.');
  // "X is typing..." (2026-10-12): who is typing to whom, and when they last pressed a key. A table
  // rather than server memory, so it reaches someone connected to another server (cloud / office /
  // SM) through replication, as the messages do. A row older than a few seconds means "stopped".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_typing (
      user_id BIGINT NOT NULL,
      to_user_id BIGINT NOT NULL,
      typed_at DATETIME(3) NOT NULL,
      PRIMARY KEY (user_id, to_user_id),
      KEY idx_chat_typing_to (to_user_id, typed_at)
    ) DEFAULT CHARSET=${coll.split('_')[0]} COLLATE=${coll}`);
  console.log('chat_typing ready.');

  const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  let pageId = page?.id;
  if (!pageId) {
    const [r] = await pool.query("INSERT INTO pages (name, route, sort_order, is_active) VALUES ('Chat', ?, 99, TRUE)", [ROUTE]);
    pageId = r.insertId;
    console.log(`Registered ${ROUTE} (id ${pageId}).`);
  } else console.log(`Page ${ROUTE} already registered (id ${pageId}).`);

  // System Admins have it anyway (userCan); written out so Users & Permissions shows it ticked.
  const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const u of admins) {
    const [[p]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [u.id, pageId]);
    if (p) await pool.query('UPDATE user_page_permissions SET can_view = TRUE WHERE id = ?', [p.id]);
    else await pool.query('INSERT INTO user_page_permissions (user_id, page_id, can_view) VALUES (?, ?, TRUE)', [u.id, pageId]);
  }
  console.log(`${admins.length} System Admin(s) given Chat. Grant everyone else in Users & Permissions.`);
  await pool.end();
}

main().catch(async (err) => { console.error(err.message || err); await pool.end(); process.exit(1); });
