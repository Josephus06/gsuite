// Saved translations: highlight text, Translate, then Save -- and from then on that page shows the
// English in place of the original for everyone. See routes/translate.js and
// client/src/components/SelectionTranslator.jsx.
//
// A DISPLAY LAYER, NOT AN EDIT. The record itself (an incident report's narrative, a memo) is never
// changed: the original words are what the person wrote, and on HR records they are evidence. The
// page swaps the text as it renders and anyone can switch back to the original.
//
// Scoped to the page it was saved on (page_path, e.g. /incident-reports/681), so a short phrase
// saved on one record does not start rewriting the same words on every other screen.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/create-saved-translations.js
const pool = require('../db');

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);
  const [[t]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'saved_translations'`,
  );
  if (t.n) {
    console.log('  Table saved_translations already exists.');
  } else {
    await pool.query(`
      CREATE TABLE saved_translations (
        id BIGINT NOT NULL AUTO_INCREMENT,
        page_path VARCHAR(255) NOT NULL,
        original_text TEXT NOT NULL,
        original_hash CHAR(64) NOT NULL,
        translation TEXT NOT NULL,
        language VARCHAR(60) NULL,
        created_by_user_id BIGINT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_saved_translations_page_text (page_path, original_hash)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('  Created table saved_translations.');
  }
  console.log('\nDone.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
