// Chat, Messenger-style (2026-10-13; db/add-chat-media.js): what a message carries besides its text
// -- photos and files, reactions, the message it replies to -- and who may touch it. Shared by
// one-to-one ('dm', chat_messages) and group ('group', chat_group_messages) chat in routes/chat.js.
const pool = require('../db');

const TABLE = { dm: 'chat_messages', group: 'chat_group_messages' };
const MAX_FILES = 6;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // one message's files together -- what the 36mb parser carries
// The reactions offered, as Messenger has them.
const REACTIONS = ['👍', '❤️', '😆', '😮', '😢', '😡'];
const noTable = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR');

// Attachments (without their bytes), reactions and reply previews for a list of messages, added in
// place. An unsent message keeps only who sent it and when.
async function decorate(kind, rows, me) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  let atts = []; let reacts = []; let replies = [];
  try {
    [atts] = await pool.query(
      'SELECT id, message_id, file_name, mime_type, size_bytes FROM chat_attachments WHERE kind = ? AND message_id IN (?) ORDER BY id',
      [kind, ids]);
    [reacts] = await pool.query(
      `SELECT r.message_id, r.user_id, r.emoji, u.display_name FROM chat_reactions r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.kind = ? AND r.message_id IN (?) ORDER BY r.created_at`, [kind, ids]);
    const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter(Boolean))];
    if (replyIds.length) {
      [replies] = await pool.query(
        `SELECT m.id, m.body, m.unsent_at, m.sender_user_id, u.display_name AS sender_name,
                (SELECT COUNT(*) FROM chat_attachments a WHERE a.kind = ? AND a.message_id = m.id) AS att_count
           FROM ${TABLE[kind]} m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.id IN (?)`, [kind, replyIds]);
    }
  } catch (err) {
    if (!noTable(err)) throw err; // db/add-chat-media.js not run yet: plain messages
  }
  const replyById = new Map(replies.map((r) => [Number(r.id), r]));
  for (const m of rows) {
    const unsent = !!m.unsent_at;
    m.unsent = unsent;
    if (unsent) m.body = '';
    m.attachments = unsent ? [] : atts.filter((a) => Number(a.message_id) === Number(m.id)).map((a) => ({
      id: a.id, file_name: a.file_name, mime_type: a.mime_type, size_bytes: a.size_bytes, is_image: /^image\//.test(a.mime_type),
    }));
    const mine = reacts.filter((r) => Number(r.message_id) === Number(m.id));
    const byEmoji = new Map();
    for (const r of mine) {
      if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, { emoji: r.emoji, count: 0, names: [], mine: false });
      const e = byEmoji.get(r.emoji);
      e.count += 1; e.names.push(r.display_name);
      if (Number(r.user_id) === Number(me)) e.mine = true;
    }
    m.reactions = unsent ? [] : [...byEmoji.values()];
    const rp = m.reply_to_id ? replyById.get(Number(m.reply_to_id)) : null;
    m.reply = rp ? {
      id: rp.id, sender_user_id: rp.sender_user_id, sender_name: rp.sender_name,
      body: rp.unsent_at ? '' : String(rp.body || '').slice(0, 140), unsent: !!rp.unsent_at, att_count: Number(rp.att_count) || 0,
    } : null;
  }
  return rows;
}

// May this user see / react to this message? dm: its sender or recipient. group: a member.
async function messageAccess(kind, messageId, userId) {
  if (kind === 'dm') {
    const [[m]] = await pool.query('SELECT id, sender_user_id, recipient_user_id, unsent_at FROM chat_messages WHERE id = ?', [messageId]);
    if (!m || (Number(m.sender_user_id) !== Number(userId) && Number(m.recipient_user_id) !== Number(userId))) return null;
    return { ...m, notify: [Number(m.sender_user_id), Number(m.recipient_user_id)] };
  }
  if (kind === 'group') {
    const [[m]] = await pool.query('SELECT id, group_id, sender_user_id, unsent_at FROM chat_group_messages WHERE id = ?', [messageId]);
    if (!m) return null;
    const [members] = await pool.query('SELECT user_id FROM chat_group_members WHERE group_id = ?', [m.group_id]);
    if (!members.some((r) => Number(r.user_id) === Number(userId))) return null;
    return { ...m, notify: members.map((r) => Number(r.user_id)) };
  }
  return null;
}

// Files sent with a message: [{ file_name, mime_type, data }] -- data a base64 string or a data: URL.
// Returns an error string, or the cleaned list.
function readFiles(list) {
  const files = Array.isArray(list) ? list : [];
  if (files.length > MAX_FILES) return { error: `Send at most ${MAX_FILES} files at a time.` };
  const out = [];
  for (const f of files) {
    const raw = String(f?.data || '');
    const buf = Buffer.from(raw.includes(',') ? raw.split(',').pop() : raw, 'base64');
    if (!buf.length) return { error: 'One of the files is empty.' };
    if (buf.length > MAX_FILE_BYTES) return { error: 'Files must be 10 MB or smaller.' };
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(String(f?.mime_type || '')) ? String(f.mime_type).slice(0, 100) : 'application/octet-stream';
    out.push({ file_name: String(f?.file_name || 'file').slice(0, 255), mime_type: mime, buf });
  }
  if (out.reduce((t, f) => t + f.buf.length, 0) > MAX_TOTAL_BYTES) return { error: 'Files sent together must be 25 MB or smaller.' };
  return { files: out };
}

async function saveFiles(conn, kind, messageId, files) {
  for (const f of files) {
    await conn.query(
      'INSERT INTO chat_attachments (kind, message_id, file_name, mime_type, size_bytes, file_data) VALUES (?, ?, ?, ?, ?, ?)',
      [kind, messageId, f.file_name, f.mime_type, f.buf.length, f.buf]);
  }
}

module.exports = { TABLE, REACTIONS, decorate, messageAccess, readFiles, saveFiles, noTable };
