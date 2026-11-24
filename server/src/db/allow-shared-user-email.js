// One-off migration (2026-11-24): users may share an email address (asked: "allow user to have the same
// email") -- e.g. one mailbox for several accounts. Replaces the UNIQUE index on users.email with an
// ordinary one, so email lookups stay fast. Usernames stay unique. Sign-in by email copes with a
// shared address (routes/auth.js findLoginUser).
//
//   node src/db/allow-shared-user-email.js [--dry-run]
//
// The droplet, office and SM boxes replicate: run on ONE box (the droplet). Railway: run it there too.
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`DB: ${db}${DRY_RUN ? ' -- DRY RUN' : ''}`);
  const [idx] = await pool.query("SHOW INDEX FROM users WHERE Column_name = 'email'");
  const unique = [...new Set(idx.filter((i) => !i.Non_unique).map((i) => i.Key_name))];
  const plain = idx.filter((i) => i.Non_unique).map((i) => i.Key_name);
  if (!unique.length) console.log('  = users.email is already not unique');
  for (const name of unique) {
    if (DRY_RUN) { console.log(`  ~ would drop UNIQUE index \`${name}\` on users.email`); continue; }
    await pool.query(`ALTER TABLE users DROP INDEX \`${name}\``);
    console.log(`  - dropped UNIQUE index \`${name}\``);
  }
  if (plain.length) console.log(`  = plain index already there (${plain.join(', ')})`);
  else if (DRY_RUN) console.log('  ~ would add plain index idx_users_email');
  else { await pool.query('ALTER TABLE users ADD INDEX idx_users_email (email)'); console.log('  + added plain index idx_users_email'); }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
