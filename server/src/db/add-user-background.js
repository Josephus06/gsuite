// Adds the one field the personal site background needs.
//
//   bg_data - the wallpaper image a user picks for their own view of the app, stored
//             inline as a data URL exactly like users.avatar_data and users.cover_data
//             already are, so there is still no upload directory to deploy or back up.
//
// This is a per-user display preference, not shared content -- nobody else ever sees it,
// the same way the Day/Night toggle only affects the person who flipped it.
//
// Idempotent; safe to re-run and safe to run against a live database.
const pool = require('../db');

async function columnExists(table, column) {
  const [r] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return r.length > 0;
}

// No "AFTER <column>" clause, for the same reason as add-user-profile.js: appending is a
// metadata-only change that returns immediately, while positioning a column forces InnoDB
// to rebuild the whole users table behind an exclusive lock.
const COLUMNS = [
  ['bg_data', 'ALTER TABLE users ADD COLUMN bg_data MEDIUMTEXT NULL'],
];

// Ask for INSTANT explicitly so a server that cannot do it errors loudly instead of
// silently falling back to a table copy. Older servers get the plain form.
async function addColumn(name, ddl) {
  try {
    await pool.query(`${ddl}, ALGORITHM=INSTANT`);
    console.log(`  + added users.${name} (instant)`);
  } catch (err) {
    if (err.code !== 'ER_PARSE_ERROR' && err.errno !== 1845 && err.errno !== 1846) throw err;
    await pool.query(ddl);
    console.log(`  + added users.${name}`);
  }
}

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`Local DB: ${db}`);

  for (const [name, ddl] of COLUMNS) {
    if (await columnExists('users', name)) {
      console.log(`  = users.${name} already exists, skipping`);
      continue;
    }
    await addColumn(name, ddl);
  }

  console.log('\nDone.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
