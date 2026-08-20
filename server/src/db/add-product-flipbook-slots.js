// Photo slots for the built-in profile pages.
//
// The "Our Work" pages carry an empty frame where a project photograph belongs, and until now
// the only way to get a picture into the book was to replace the whole page with an uploaded
// image. A slot lets one photo drop into one frame while the rest of the page stays as it is.
//
// Slotted rows live in the same table as full-page uploads and are told apart by this column:
// slot IS NULL means a page of the book, slot = 'work-11' means the photo for that frame.
// MySQL permits many NULLs in a unique index, so the uniqueness only binds the slotted rows,
// which is what makes re-uploading a frame a replacement rather than a second copy.
//
// Idempotent -- safe to re-run:
//   node src/db/add-product-flipbook-slots.js
require('dotenv').config();
const pool = require('../db');

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[col]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'product_flipbook_pages'
        AND column_name = 'slot'`,
  );
  if (col.n) {
    console.log('  slot already exists -- skipped.');
  } else {
    await pool.query('ALTER TABLE product_flipbook_pages ADD COLUMN slot VARCHAR(40) NULL AFTER position');
    console.log('  slot added.');
  }

  const [[idx]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'product_flipbook_pages'
        AND index_name = 'uq_product_flipbook_slot'`,
  );
  if (idx.n) {
    console.log('  uq_product_flipbook_slot already exists -- skipped.');
  } else {
    await pool.query('ALTER TABLE product_flipbook_pages ADD UNIQUE KEY uq_product_flipbook_slot (slot)');
    console.log('  uq_product_flipbook_slot added.');
  }

  const [[c]] = await pool.query('SELECT COUNT(*) n FROM product_flipbook_pages WHERE slot IS NOT NULL');
  console.log(`Done. ${c.n} filled photo slot(s).`);
  await pool.end();
}

main().catch((err) => { console.error('Product flipbook slot setup failed:', err); process.exit(1); });
