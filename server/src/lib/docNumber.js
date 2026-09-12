// Allocating the next document number for a table whose number column is UNIQUE.
//
// WHY THIS IS NOT JUST `PO-${insertId}`. Documents were imported from the live system carrying
// THEIR ORIGINAL NUMBERS while their ids were reassigned, so a number and the id of the row
// holding it have nothing to do with each other: PO-19571 belongs to row 438. Deriving the number
// from the auto-increment works right up until that counter climbs into the range the imported
// numbers occupy, and then every create is a coin toss -- "Duplicate entry 'PO-19571' for key
// 'purchase_orders.po_no'" is that coin landing badly. Measured on purchase_orders: 19,470 of
// 19,475 rows carry a number that is not their own id, and 498 of those sit at or above the next
// id, so they were 498 failures waiting to happen.
//
// Transfer orders, fulfilments and receipts hit this first and were fixed in place; this is that
// fix lifted out so the next table does not have to rediscover it.
const pool = require('../db');

// Read on the POOL, not on the caller's connection, and deliberately so.
//
// The caller is inside a transaction, and InnoDB's default REPEATABLE READ pins that transaction
// to the snapshot of its first read. So when two creates race, the loser's retry re-reads its own
// stale snapshot, cannot see the row the winner just committed, computes the same number again,
// and fails on every attempt. A separate autocommit connection sees the current committed state,
// which is what "the next free number" has to mean.
async function nextDocNo(table, column, prefix) {
  const [[mx]] = await pool.query(
    'SELECT COALESCE(MAX(CAST(SUBSTRING(??, ?) AS UNSIGNED)), 0) AS n FROM ?? WHERE ?? REGEXP ?',
    [column, prefix.length + 1, table, column, `^${prefix}[0-9]+$`],
  );
  return `${prefix}${mx.n + 1}`;
}

// Insert a row whose document number has to be unique, writing that number in the INSERT itself.
//
// A two-step insert -- put a placeholder in, UPDATE the real number after -- cannot work on a
// UNIQUE column: two people creating at the same moment collide on the placeholder before either
// has a number at all. Reading the maximum and inserting still is not atomic either, so a clash is
// RETRIED rather than prevented: the loser simply takes the next number. A duplicate-key error
// does not abort a MySQL transaction, so the retry is safe inside the caller's.
async function insertNumbered(conn, { table, column, prefix, run }) {
  for (let attempt = 0; ; attempt += 1) {
    const no = await nextDocNo(table, column, prefix);
    try {
      const [result] = await run(no);
      return { id: result.insertId, no };
    } catch (err) {
      // Anything but a number clash is a real failure, and so is losing the race five times.
      if (err.code !== 'ER_DUP_ENTRY' || attempt >= 4) throw err;
    }
  }
}

module.exports = { nextDocNo, insertNumbered };
