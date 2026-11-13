// Sales > NSJO (asked 2026-11-13): the Job Orders raised from a Non-Standard Sales Order get a module
// of their own, and the Job Orders module stops listing them. Registers the /nsjo page.
//
// NOBODY LOSES ACCESS: until now an NSJO was seen through Job Orders, so every user's Job Orders
// rights are copied onto NSJO -- only for users with no NSJO row yet, so a re-run never undoes a
// grant someone has since changed. System Admins get every right. Adjust in Users & Permissions after.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-nsjo-page.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const ROUTE = '/nsjo';
  const SOURCE = '/job-orders';
  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  let pageId = existing?.id;
  if (!pageId) {
    const [r] = await pool.query('INSERT INTO pages (route, name, is_active) VALUES (?, ?, TRUE)', [ROUTE, 'NSJO']);
    pageId = r.insertId;
    console.log(`  registered ${ROUTE} (id ${pageId})`);
  } else console.log(`  page ${ROUTE} already registered (id ${pageId})`);
  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  if (cols.some((c) => c.Field === 'module')) await pool.query("UPDATE pages SET module = 'Sales' WHERE id = ? AND module IS NULL", [pageId]);

  const [permCols] = await pool.query('SHOW COLUMNS FROM user_page_permissions');
  const flags = permCols.map((c) => c.Field).filter((f) => /^can_/.test(f));
  const [[source]] = await pool.query('SELECT id FROM pages WHERE route = ?', [SOURCE]);
  if (source) {
    const [copied] = await pool.query(
      `INSERT INTO user_page_permissions (user_id, page_id, ${flags.join(', ')})
       SELECT src.user_id, ?, ${flags.map((f) => `src.${f}`).join(', ')}
         FROM user_page_permissions src
        WHERE src.page_id = ?
          AND NOT EXISTS (SELECT 1 FROM user_page_permissions d WHERE d.user_id = src.user_id AND d.page_id = ?)`,
      [pageId, source.id, pageId]);
    console.log(`  ${copied.affectedRows} user(s) given their Job Orders rights on NSJO`);
  }

  const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const a of admins) {
    const [[p]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [a.id, pageId]);
    if (p) await pool.query(`UPDATE user_page_permissions SET ${flags.map((f) => `${f} = TRUE`).join(', ')} WHERE id = ?`, [p.id]);
    else await pool.query(`INSERT INTO user_page_permissions (user_id, page_id, ${flags.join(', ')}) VALUES (?, ?, ${flags.map(() => 'TRUE').join(', ')})`, [a.id, pageId]);
  }
  console.log(`  ${admins.length} System Admin(s) given every right on NSJO`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
