// Adds the two user-authored fields the profile page needs on top of what the ERP already
// knows about someone (position, department, branch, hire date -- all read from employees /
// user_groups / locations, nothing to store).
//
//   bio        - short "Intro" blurb the user writes about themselves
//   cover_data - profile cover photo, stored inline as a data URL exactly like
//                users.avatar_data already is, so there is still no upload directory
//
// Idempotent; safe to re-run and safe to run against a live database.
const pool = require('../db');

async function columnExists(table, column) {
  const [r] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return r.length > 0;
}

// Deliberately NO "AFTER <column>" clause. Positioning a new column forces InnoDB to rebuild
// the entire table (ALGORITHM=INSTANT is only available when the column is appended at the
// end), which needs an exclusive metadata lock plus scratch disk equal to the table. Against a
// live database that stalls behind the app's own connections; on a space-constrained volume it
// can fail outright. Appending is metadata-only and returns immediately. Column order in the
// table has no effect on anything -- every query here names its columns.
const COLUMNS = [
  ['bio', 'ALTER TABLE users ADD COLUMN bio VARCHAR(500) NULL'],
  ['cover_data', 'ALTER TABLE users ADD COLUMN cover_data MEDIUMTEXT NULL'],
];

// Ask for INSTANT explicitly so a server that cannot do it errors loudly instead of silently
// falling back to a table copy. Older servers that don't know the keyword get the plain form.
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
