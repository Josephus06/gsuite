// Group chats (2026-10-13) -- the tables. A group has a name and members; its messages are kept
// (lib/chatPurge.js clears only one-to-one chat). Each member's last_read_id is the newest group
// message they have read, which gives their unread count.
//
// Who may do what (routes/chat.js):
//   create a group          Can Add on Chat (/chat) -- "Create Group Chat" -- in Users & Permissions
//   rename, add / remove    the group's creator only
//   read and send           every member (each still needs Chat itself)
//
// Idempotent.   node src/db/create-chat-groups.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[ref]] = await pool.query(
    "SELECT TABLE_COLLATION AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users'");
  const coll = ref?.c || 'utf8mb4_unicode_ci';
  const cs = `DEFAULT CHARSET=${coll.split('_')[0]} COLLATE=${coll}`;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_groups (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(100) NOT NULL,
      created_by_user_id BIGINT NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ${cs}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_group_members (
      group_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      last_read_id BIGINT NOT NULL DEFAULT 0,
      joined_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (group_id, user_id),
      KEY idx_cgm_user (user_id)
    ) ${cs}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_group_messages (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      group_id BIGINT NOT NULL,
      sender_user_id BIGINT NOT NULL,
      body TEXT NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_cgmsg_group (group_id, id)
    ) ${cs}`);
  console.log('chat_groups, chat_group_members, chat_group_messages ready.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
