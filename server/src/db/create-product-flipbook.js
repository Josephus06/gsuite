// Uploadable artwork for the Product flipbook.
//
// The module ships with the 2025 profile transcribed into HTML pages, which works but carries
// no photographs. This table lets someone upload the real exported pages instead -- one image
// per page -- so next year's profile is a drag and drop rather than a code change.
//
// The flipbook uses uploaded pages when any exist and falls back to the built-in ones when the
// table is empty, so the module is never blank and an upload can be undone by deleting.
//
// Images live in the database as LONGBLOB, like every other upload here: no object storage is
// configured and Railway wipes the filesystem on redeploy.
//
// Idempotent -- safe to re-run:
//   node src/db/create-product-flipbook.js
require('dotenv').config();
const pool = require('../db');

const DDL = `
CREATE TABLE product_flipbook_pages (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    position INT NOT NULL DEFAULT 0,
    file_name VARCHAR(255) NULL,
    caption VARCHAR(255) NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes INT NOT NULL,
    file_data LONGBLOB NOT NULL,
    uploaded_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_product_flipbook_order (position, id)
)`;

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[t]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'product_flipbook_pages'`,
  );
  if (t.n) {
    console.log('  product_flipbook_pages already exists -- skipped.');
  } else {
    await pool.query(DDL);
    console.log('  product_flipbook_pages created.');
  }

  const [[p]] = await pool.query("SELECT id FROM pages WHERE route = '/product'");
  const [[c]] = await pool.query('SELECT COUNT(*) n FROM product_flipbook_pages');
  console.log(`Done. ${c.n} uploaded page(s). Managing artwork needs can_edit on /product`
    + `${p ? ` (page id ${p.id})` : " -- WARNING: that page row is missing, run register-product-page.js first"}.`);
  await pool.end();
}

main().catch((err) => { console.error('Product flipbook setup failed:', err); process.exit(1); });
