// Chat, Messenger-style (2026-10-13): photos and files, reactions, replies and unsend -- for
// one-to-one (chat_messages) and group (chat_group_messages) messages alike.
//
//   reply_to_id   the message this one answers (same table)
//   unsent_at     the sender took it back: shown to everyone as "unsent", its files removed
//   rev_at        last time a reaction or an unsend changed it -- the poll delivers such changes
//   chat_attachments  the files, kept in the database like form attachments (kind 'dm' | 'group')
//   chat_reactions    one reaction per person per message
//
// Idempotent. Run before deploying the code that uses it.
//   node src/db/add-chat-media.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

async function addColumns(table) {
  const [cols] = await pool.query('SHOW COLUMNS FROM ??', [table]);
  const have = new Set(cols.map((c) => c.Field));
  const add = [];
  if (!have.has('reply_to_id')) add.push('ADD COLUMN reply_to_id BIGINT NULL');
  if (!have.has('unsent_at')) add.push('ADD COLUMN unsent_at DATETIME NULL');
  if (!have.has('rev_at')) add.push('ADD COLUMN rev_at DATETIME(3) NULL, ADD KEY idx_rev_at (rev_at)');
  if (add.length) { await pool.query(`ALTER TABLE ${table} ${add.join(', ')}`); console.log(`${table}: ${add.length} change(s).`); }
  else console.log(`${table}: already has reply / unsend / rev.`);
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[ref]] = await pool.query(
    "SELECT TABLE_COLLATION AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users'");
  const coll = ref?.c || 'utf8mb4_unicode_ci';
  const cs = `DEFAULT CHARSET=${coll.split('_')[0]} COLLATE=${coll}`;
  await addColumns('chat_messages');
  await addColumns('chat_group_messages');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_attachments (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      kind VARCHAR(10) NOT NULL,
      message_id BIGINT NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      size_bytes INT NOT NULL,
      file_data LONGBLOB NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_chat_att_msg (kind, message_id)
    ) ${cs}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_reactions (
      kind VARCHAR(10) NOT NULL,
      message_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      emoji VARCHAR(16) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (kind, message_id, user_id),
      KEY idx_chat_react_msg (kind, message_id)
    ) ${cs}`);
  console.log('chat_attachments, chat_reactions ready.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
