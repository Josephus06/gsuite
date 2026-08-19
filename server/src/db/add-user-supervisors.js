// Lets a user report to more than one supervisor.
//
// Until now the relationship was the single `users.supervisor_id` column, so an account
// officer shared between two supervisors could only ever appear under one of them -- the
// other supervisor's Dashboard, sales list and commission team total silently omitted that
// rep. This moves the relationship into its own table and backfills it from the column.
//
// `users.supervisor_id` is deliberately NOT dropped: it stays as the *primary* supervisor,
// kept in sync by src/routes/users.js, so any reader still pointing at it resolves to a
// sensible single answer instead of NULL.
//
// Idempotent -- safe to run against a database that already has the table, and safe to
// re-run (the backfill is INSERT IGNORE against a unique key).
//
//   node src/db/add-user-supervisors.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_supervisors (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id BIGINT NOT NULL,
      supervisor_id BIGINT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_user_supervisor (user_id, supervisor_id),
      KEY idx_user_supervisors_supervisor (supervisor_id)
    )
  `);
  console.log('user_supervisors: table present.');

  // Backfill from the legacy column. Self-references are excluded -- a user supervising
  // themselves would make the commission BFS treat its own root as a report.
  const [r] = await pool.query(`
    INSERT IGNORE INTO user_supervisors (user_id, supervisor_id)
    SELECT u.id, u.supervisor_id
    FROM users u
    JOIN users s ON s.id = u.supervisor_id
    WHERE u.supervisor_id IS NOT NULL AND u.supervisor_id <> u.id
  `);
  console.log(`Backfilled ${r.affectedRows} relationship(s) from users.supervisor_id.`);

  const [[{ pairs }]] = await pool.query('SELECT COUNT(*) AS pairs FROM user_supervisors');
  const [[{ multi }]] = await pool.query(
    'SELECT COUNT(*) AS multi FROM (SELECT user_id FROM user_supervisors GROUP BY user_id HAVING COUNT(*) > 1) t'
  );
  // A row here whose user no longer exists in users would break the joins that read it.
  const [[{ orphans }]] = await pool.query(`
    SELECT COUNT(*) AS orphans FROM user_supervisors us
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = us.user_id)
       OR NOT EXISTS (SELECT 1 FROM users s WHERE s.id = us.supervisor_id)
  `);
  console.log(`Total: ${pairs} pair(s); ${multi} user(s) with more than one supervisor; ${orphans} orphan row(s).`);

  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
