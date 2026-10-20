// HRD > OBT (asked 2026-10-20): every APPROVED Official Business Trip form (Forms > Business Trip)
// listed for HR, each with a Confirm button -- HR's confirmation that the trip took place as filed.
//
//   form_business_trip_details.obt_confirmed_at         (new)  when HR confirmed it, else NULL
//   form_business_trip_details.obt_confirmed_by_user_id (new)  who confirmed it
//   form_business_trip_details.obt_returned_at          (new)  when "Back in Office" was clicked -- it
//                                                              also fills the trip's Time In (2026-10-20)
//   form_business_trip_details.obt_returned_by_user_id  (new)  who clicked it
//   pages /hrd/obt  "OBT"   View lists them; Update confirms. System Admins get every right.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-obt-confirmation.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const [col, def] of [['obt_confirmed_at', 'DATETIME NULL'], ['obt_confirmed_by_user_id', 'BIGINT NULL'],
    ['obt_returned_at', 'DATETIME NULL'], ['obt_returned_by_user_id', 'BIGINT NULL']]) {
    const [c] = await pool.query('SHOW COLUMNS FROM form_business_trip_details LIKE ?', [col]);
    if (c.length) console.log(`  form_business_trip_details.${col} already there -- skipped`);
    else { await pool.query(`ALTER TABLE form_business_trip_details ADD COLUMN ${col} ${def}`); console.log(`  added form_business_trip_details.${col}`); }
  }

  const ROUTE = '/hrd/obt';
  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  let pageId = existing?.id;
  if (!pageId) {
    const [r] = await pool.query('INSERT INTO pages (route, name, is_active) VALUES (?, ?, TRUE)', [ROUTE, 'OBT']);
    pageId = r.insertId;
    console.log(`  registered ${ROUTE} (id ${pageId})`);
  } else console.log(`  page ${ROUTE} already registered (id ${pageId})`);
  const [permCols] = await pool.query('SHOW COLUMNS FROM user_page_permissions');
  const flags = permCols.map((c) => c.Field).filter((f) => /^can_/.test(f));
  const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const a of admins) {
    const [[p]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [a.id, pageId]);
    if (p) await pool.query(`UPDATE user_page_permissions SET ${flags.map((f) => `${f} = TRUE`).join(', ')} WHERE id = ?`, [p.id]);
    else await pool.query(`INSERT INTO user_page_permissions (user_id, page_id, ${flags.join(', ')}) VALUES (?, ?, ${flags.map(() => 'TRUE').join(', ')})`, [a.id, pageId]);
  }
  console.log(`  ${admins.length} System Admin(s) given every right on OBT`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
