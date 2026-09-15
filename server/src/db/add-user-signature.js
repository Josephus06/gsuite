// A user's SIGNATURE, drawn once and reused on every document they sign off.
//
//   signature_data  the drawn signature, inline as a data URL exactly like users.avatar_data
//                   and users.cover_data already are -- so there is still no upload directory
//   signature_set_at  when they last drew it, so the profile can say whether one exists and
//                   when it was captured
//
// WHY INLINE AND NOT A FILE. Every other user-authored image in this system rides in a
// MEDIUMTEXT as a data URL, and a signature is the smallest of them -- a few KB of PNG from a
// canvas. Introducing a disk path here would mean a signature that survives in the database but
// not in a restore, on a feature whose whole point is that the document still shows who signed
// it years later.
//
// WHAT IT IS FOR: the Requested By / Noted By / Approved By blocks on the printed request forms
// (client/src/pages/FormPrint.jsx). The name is already printed under each line; this puts the
// person's own mark above it, the way the paper form was signed by hand.
//
// A SIGNATURE IS NOT AN AUTHORISATION. It is drawn on the document AFTER the workflow has
// recorded who noted or approved it, from that recorded user's row -- it never decides anything,
// and an empty one simply leaves the line blank to be signed by hand as before.
//
// Idempotent; safe to re-run and safe to run against a live database.
const pool = require('../db');

async function columnExists(table, column) {
  const [r] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return r.length > 0;
}

// Deliberately NO "AFTER <column>" clause -- same reasoning as add-user-profile.js: positioning a
// new column forces InnoDB to rebuild the whole table, while appending is metadata-only.
const COLUMNS = [
  ['signature_data', 'ALTER TABLE users ADD COLUMN signature_data MEDIUMTEXT NULL'],
  ['signature_set_at', 'ALTER TABLE users ADD COLUMN signature_set_at DATETIME NULL'],
];

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
  console.log(`Database: ${db} on ${process.env.DB_HOST}\n`);

  for (const [name, ddl] of COLUMNS) {
    if (await columnExists('users', name)) {
      console.log(`  users.${name} already exists.`);
    } else {
      await addColumn(name, ddl);
    }
  }

  const [[s]] = await pool.query(
    'SELECT COUNT(*) AS total, SUM(signature_data IS NOT NULL) AS signed FROM users WHERE is_active = 1');
  console.log(`\n  ${s.signed || 0} of ${s.total} active users have a signature on file.`);
  console.log('  Drawn on the User Account step of Add/Update User (Users > Edit).');
  console.log('  Where none exists the printed line is simply left blank to sign by hand.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
