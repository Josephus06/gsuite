// Clears out notifications that were already read.
//
// Reading one now deletes it (see routes/notifications.js), so is_read = TRUE rows are the
// backlog from before that rule -- exactly the pile the change exists to get rid of. Without
// this the bell would keep showing them below the unread ones for as long as they sit in the
// table, since nothing marks them read a second time.
//
// The is_read column is left in place. It costs nothing, every surviving row is FALSE by
// construction, and dropping a column is not worth the risk on three databases that are
// replicating to each other.
//
// Idempotent -- safe to re-run:
//   node src/db/purge-read-notifications.js
require('dotenv').config();
const pool = require('../db');

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [[before]] = await pool.query(
    'SELECT COUNT(*) AS total, SUM(is_read = TRUE) AS read_rows FROM notifications',
  );
  console.log(`  ${before.total} notification(s), ${Number(before.read_rows) || 0} already read.`);

  if (!Number(before.read_rows)) {
    console.log('  Nothing to purge -- skipped.');
  } else {
    // Deleted in batches: on the live database this is thousands of rows, and one big DELETE
    // holds locks long enough to stall the bell polling every five seconds for every user.
    let removed = 0;
    for (;;) {
      const [result] = await pool.query('DELETE FROM notifications WHERE is_read = TRUE LIMIT 1000');
      removed += result.affectedRows;
      if (!result.affectedRows) break;
    }
    console.log(`  ${removed} read notification(s) deleted.`);
  }

  const [[after]] = await pool.query('SELECT COUNT(*) AS total FROM notifications');
  console.log(`Done. ${after.total} outstanding notification(s) left.`);
  await pool.end();
}

main().catch((err) => { console.error('Purge failed:', err); process.exit(1); });
