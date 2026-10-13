// Group Chat permission (asked 2026-10-13): creating a group chat gets its own row in Users &
// Permissions -- "Group Chat", Can Add -- instead of riding on Can Add of Chat (routes/chat.js
// canCreateGroup). Chat (view) is still what lets a user chat at all.
//
// Who could create groups before (Can Add on Chat) keeps it: they are given Can View + Can Add on
// the new row. System Admins are ticked too, so the screen shows what they have anyway.
//
// Idempotent. Droplet and office replicate: run on ONE of them.
//   node src/db/add-group-chat-permission.js
require('dotenv').config();
const pool = require('../db');

const ROUTE = '/chat-groups';
const CHAT = '/chat';

async function grant(userId, pageId) {
  const [[p]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [userId, pageId]);
  if (p) await pool.query('UPDATE user_page_permissions SET can_view = TRUE, can_add = TRUE WHERE id = ?', [p.id]);
  else await pool.query('INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add) VALUES (?, ?, TRUE, TRUE)', [userId, pageId]);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  let pageId = page?.id;
  if (!pageId) {
    const [r] = await pool.query("INSERT INTO pages (name, route, sort_order, is_active) VALUES ('Group Chat', ?, 99, TRUE)", [ROUTE]);
    pageId = r.insertId;
    console.log(`Registered ${ROUTE} (id ${pageId}).`);
  } else console.log(`Page ${ROUTE} already registered (id ${pageId}).`);

  const [had] = await pool.query(
    `SELECT DISTINCT p.user_id AS id FROM user_page_permissions p JOIN pages pg ON pg.id = p.page_id
      WHERE pg.route = ? AND p.can_add = TRUE`, [CHAT]);
  const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  const ids = [...new Set([...had, ...admins].map((u) => u.id))];
  for (const id of ids) await grant(id, pageId);
  console.log(`${had.length} user(s) with Can Add on Chat and ${admins.length} System Admin(s) given Group Chat (Can View + Can Add).`);
  await pool.end();
}

main().catch(async (err) => { console.error(err.message || err); await pool.end(); process.exit(1); });
