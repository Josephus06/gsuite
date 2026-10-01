// users.can_edit_approved_po -- a per-user switch letting that person edit a Purchase Order after
// it is approved (2026-10-01, asked for KRIS IMEE MODEQUILLO). Per user rather than the page's
// can_update, which seven people already hold. The PO update route still refuses removing or
// re-quantifying a line that has been received or billed.
//
//   node src/db/add-can-edit-approved-po.js [--grant=kris.imee]
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [cols] = await pool.query("SHOW COLUMNS FROM users LIKE 'can_edit_approved_po'");
  if (cols.length) console.log('users.can_edit_approved_po already present.');
  else {
    await pool.query('ALTER TABLE users ADD COLUMN can_edit_approved_po TINYINT(1) NOT NULL DEFAULT 0');
    console.log('Added users.can_edit_approved_po.');
  }
  const grant = (process.argv.find((a) => a.startsWith('--grant=')) || '').split('=')[1];
  if (grant) {
    const [r] = await pool.query('UPDATE users SET can_edit_approved_po = 1 WHERE username = ?', [grant]);
    console.log(`Granted to ${grant}: ${r.affectedRows} row(s).`);
  }
  await pool.end();
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
