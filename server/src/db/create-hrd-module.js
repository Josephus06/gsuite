// Creates the HRD module: named rooms, each holding uploaded files of any type.
//
// Files live in the database as LONGBLOB, exactly like job_order_attachments, rather than on
// disk. This app has no object storage configured and Railway's filesystem is wiped on every
// redeploy, so a file written to disk would silently vanish -- the database is the only place
// an upload reliably survives here.
//
// Registers the page and grants System Admins full access in the same run, so the module can
// never be left in the state NSTDJO was in: routes deployed, page row missing, every request
// 403ing because requirePermission cannot resolve the route.
//
// Idempotent -- safe to re-run:
//   node src/db/create-hrd-module.js
require('dotenv').config();
const pool = require('../db');

const ROUTE = '/hrd';
const NAME = 'HRD';

const ROOMS_DDL = `
CREATE TABLE hrd_rooms (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    description TEXT NULL,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_hrd_room_name (name)
)`;

const FILES_DDL = `
CREATE TABLE hrd_room_files (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    room_id BIGINT NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes INT NOT NULL,
    file_data LONGBLOB NOT NULL,
    uploaded_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_hrd_files_room (room_id),
    CONSTRAINT fk_hrd_files_room FOREIGN KEY (room_id) REFERENCES hrd_rooms(id)
)`;

async function ensureTable(name, ddl) {
  const [[t]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`,
    [name],
  );
  if (t.n) { console.log(`  ${name} already exists -- skipped.`); return; }
  await pool.query(ddl);
  console.log(`  ${name} created.`);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await ensureTable('hrd_rooms', ROOMS_DDL);
  await ensureTable('hrd_room_files', FILES_DDL);

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`  page ${ROUTE} already registered (id ${page.id}).`);
  } else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name'];
    const values = [ROUTE, NAME];
    // Top-level module, like Manual and Tickets -- no parent category.
    if (has.has('module')) { fields.push('module'); values.push(NAME); }
    const [result] = await pool.query(
      `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
      values,
    );
    page = { id: result.insertId };
    console.log(`  registered ${ROUTE} as "${NAME}" (id ${page.id}).`);
  }

  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE",
  );
  for (const user of admins) {
    const [[existing]] = await pool.query(
      'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id],
    );
    if (existing) {
      await pool.query(
        'UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE WHERE id = ?',
        [existing.id],
      );
    } else {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete)
         VALUES (?, ?, TRUE, TRUE, TRUE, TRUE)`,
        [user.id, page.id],
      );
    }
    console.log(`  + ${user.display_name}: full access.`);
  }

  const [[rooms]] = await pool.query('SELECT COUNT(*) n FROM hrd_rooms');
  console.log(`Done. ${rooms.n} room(s) present.`);
  await pool.end();
}

main().catch((err) => { console.error('HRD setup failed:', err); process.exit(1); });
