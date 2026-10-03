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
// ...AND ALSO ON THE CALLER'S CONNECTION, taking whichever is higher.
//
// The pool alone is not enough, and the case it misses is not exotic: one request that creates
// SEVERAL numbered documents in one transaction. A Purchase Order request splits its lines by
// supplier and inserts one PO per group, all before committing. The pool cannot see rows this
// transaction has not committed, so the second PO computed the SAME number as the first and
// collided with its own sibling -- immediately, not by blocking, because they share a
// transaction. Every retry recomputed the same number from the same pool, so all five failed and
// the whole request rolled back. Measured on the droplet: five attempts, all 'PO-20088', and no
// PO-20088 in the table afterwards because the rollback took the first one with it.
//
// So: the pool answers "what has everyone else committed", the caller's connection answers "what
// have I taken already", and the next number has to clear both.
//
// TWO BOXES, ONE NUMBER SPACE (2026-10-03). The droplet and the office box replicate both ways and
// both take new documents, so "highest + 1" on each could hand out the same number twice -- and a
// duplicate on a UNIQUE column stops replication dead (CPAY-37 and PO-20644 did, 2026-10-02/03).
// So the office box marks its numbers: CPAY-62-O. The droplet keeps the plain series with no gaps
// and never counts the -O numbers; the office counts both, so its next number follows the latest
// document wherever it was made. Two boxes can then never write the same string.
async function nextDocNo(table, column, prefix, conn = null) {
  const suffix = await docNoSuffix();
  const sql = 'SELECT COALESCE(MAX(CAST(SUBSTRING(??, ?) AS UNSIGNED)), 0) AS n FROM ?? WHERE ?? REGEXP ?';
  const params = [column, prefix.length + 1, table, column, docNoPattern(prefix, suffix)];

  const [[committed]] = await pool.query(sql, params);
  let highest = Number(committed.n);

  if (conn) {
    const [[mine]] = await conn.query(sql, params);
    highest = Math.max(highest, Number(mine.n));
  }
  return `${prefix}${highest + 1}${suffix}`;
}

// '-O' on the office box, '' everywhere else. The box is told apart by MySQL's own
// auto_increment_offset -- 1 on the droplet, 2 on the office (see REPLICATION-RECOVERY.md) -- so
// no per-box setting has to be remembered on a redeploy. DOC_NO_SUFFIX in .env overrides it.
// Read once; the offset never changes while the server runs.
let suffixPromise = null;
function docNoSuffix() {
  if (process.env.DOC_NO_SUFFIX !== undefined) return Promise.resolve(process.env.DOC_NO_SUFFIX);
  if (!suffixPromise) {
    suffixPromise = pool.query('SELECT @@auto_increment_offset AS o')
      .then(([[r]]) => (Number(r.o) === 2 ? '-O' : ''))
      .catch((err) => { suffixPromise = null; throw err; });
  }
  return suffixPromise;
}

// The numbers a box counts when finding the next one: plain ones everywhere, and on the office box
// its own suffixed ones too. CAST('62-O' AS UNSIGNED) reads 62, so MAX works over both.
function docNoPattern(prefix, suffix) {
  return suffix ? `^${prefix}[0-9]+(${suffix})?$` : `^${prefix}[0-9]+$`;
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
    // The caller's connection is passed in, so a second document created in the same transaction
    // sees the first one and takes the number after it rather than colliding with it.
    const no = await nextDocNo(table, column, prefix, conn);
    try {
      const [result] = await run(no);
      return { id: result.insertId, no };
    } catch (err) {
      // Anything but a number clash is a real failure, and so is losing the race five times.
      if (err.code !== 'ER_DUP_ENTRY' || attempt >= 4) throw err;
    }
  }
}

// Number a row that was ALREADY inserted (with a blank or placeholder number) -- the
// insert-then-number pattern most create routes use. They used to write `PREFIX-${insertId}`,
// which is exactly the id-vs-imported-number collision described at the top of this file: on the
// droplet on 2026-09-28 the next cheque id produced CHK-15613, a number an imported cheque
// already held, so every new cheque failed. This takes the next free number instead, and on a
// clash (two creates racing) simply takes the one after.
async function assignDocNo(conn, { table, column, prefix, id }) {
  for (let attempt = 0; ; attempt += 1) {
    const no = await nextDocNo(table, column, prefix, conn);
    try {
      await conn.query('UPDATE ?? SET ?? = ? WHERE id = ?', [table, column, no, id]);
      return no;
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY' || attempt >= 4) throw err;
    }
  }
}

module.exports = { nextDocNo, insertNumbered, assignDocNo, docNoSuffix, docNoPattern };
