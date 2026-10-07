// One-off migration: a small replicated key/value table for settings that must be the SAME on every
// box at the same moment (2026-10-07). Its first and only row so far:
//
//   doc_no_slots   how many boxes share the document-number space (lib/docNumber.js). Starts at 2 --
//                  the droplet/office odd/even split already in use, so creating it changes nothing.
//                  Raise it to 3 when the SM branch server joins replication: run once, on the droplet,
//                  and replication carries it to every box at once:
//                    UPDATE app_settings SET value = '3' WHERE name = 'doc_no_slots';
//
//   node src/db/create-app-settings.js [--dry-run]
// Droplet and office replicate: run on ONE box (the droplet).
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`DB: ${db}${DRY_RUN ? ' -- DRY RUN' : ''}`);
  const [exists] = await pool.query("SHOW TABLES LIKE 'app_settings'");
  if (exists.length) console.log('  = app_settings already exists');
  else if (DRY_RUN) console.log('  ~ would create app_settings');
  else {
    await pool.query(`CREATE TABLE app_settings (
        name VARCHAR(64) PRIMARY KEY,
        value VARCHAR(255) NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('  + created app_settings');
  }
  if (!DRY_RUN) {
    await pool.query("INSERT IGNORE INTO app_settings (name, value) VALUES ('doc_no_slots', '2')");
    const [[r]] = await pool.query("SELECT value FROM app_settings WHERE name = 'doc_no_slots'");
    console.log(`  doc_no_slots = ${r.value}`);
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
