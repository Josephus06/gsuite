// The dashboard carousel: images and short videos shown in a rail beside the feed.
//
// Stored in the database as LONGBLOB, like job-order attachments and HRD files, rather than
// on disk -- there is no object storage here and Railway wipes the filesystem on redeploy,
// so anything written to disk would silently vanish.
//
// Who may upload is NOT a new concept: it is can_add on the existing /dashboard page, so it
// is granted and revoked in Users & Permissions like everything else. Nothing extra to
// remember, and no second place to look when someone asks why they cannot post to it.
//
// Idempotent -- safe to re-run:
//   node src/db/create-dashboard-carousel.js
require('dotenv').config();
const pool = require('../db');

const DDL = `
CREATE TABLE dashboard_carousel_media (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    media_type ENUM('image', 'video') NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    file_name VARCHAR(255) NULL,
    caption VARCHAR(255) NULL,
    size_bytes INT NOT NULL,
    file_data LONGBLOB NOT NULL,
    -- Lower sorts first; ties fall back to newest, so an upload with no position given
    -- still lands somewhere predictable.
    position INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    uploaded_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_carousel_order (is_active, position, id)
)`;

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[t]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'dashboard_carousel_media'`,
  );
  if (t.n) {
    console.log('  dashboard_carousel_media already exists -- skipped.');
  } else {
    await pool.query(DDL);
    console.log('  dashboard_carousel_media created.');
  }

  const [[c]] = await pool.query('SELECT COUNT(*) n FROM dashboard_carousel_media');
  const [[p]] = await pool.query("SELECT id FROM pages WHERE route = '/dashboard'");
  console.log(`Done. ${c.n} item(s). Uploads are gated on can_add for /dashboard`
    + `${p ? ` (page id ${p.id})` : ' -- WARNING: that page row is missing, so only System Admins will be able to upload'}.`);
  await pool.end();
}

main().catch((err) => { console.error('Carousel setup failed:', err); process.exit(1); });
