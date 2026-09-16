// A credit limit on the supplier, set by hand.
//
// Customers have carried one since the estimate import (`customers.credit_limit`); suppliers never
// did, so "how much is this supplier willing to let us owe" lived in somebody's memory or in the
// supplier's own paperwork. It is a term the supplier grants US, agreed once and then referred to
// every time an order is raised -- which is exactly the kind of fact that belongs on the record
// rather than in a head.
//
// Shaped identically to `customers.credit_limit` -- DECIMAL(14,2), NULL allowed, default 0.00 --
// so the two read the same way on screen and in any report that eventually puts them side by side.
//
// NOT ENFORCED, deliberately. Nothing here refuses a purchase order that would breach the limit.
// The Supplier page shows the limit against the balance already owed and what is left of it, and
// stops there. Blocking a PO is a policy decision with real consequences on a shop floor -- who
// may override it, whether a part-delivered order counts, what happens to an order already
// approved -- and none of that has been decided. Recording the figure is the ask; enforcing it
// would be inventing a rule nobody asked for.
//
// IDEMPOTENT: safe to re-run; an existing column is reported and skipped.
//
//   node src/db/add-supplier-credit-limit.js
const pool = require('../db');

async function colExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}

(async () => {
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

    if (await colExists('suppliers', 'credit_limit')) {
      console.log('  suppliers.credit_limit exists -- skipped');
    } else {
      // Appended, never positioned, and INSTANT where the server supports it.
      const ddl = 'ALTER TABLE suppliers ADD COLUMN credit_limit DECIMAL(14,2) NULL DEFAULT 0.00';
      try {
        await pool.query(`${ddl}, ALGORITHM=INSTANT`);
      } catch (err) {
        if (err.errno !== 1064) throw err;
        console.log('  (this MySQL has no ALGORITHM=INSTANT; adding it the ordinary way)');
        await pool.query(ddl);
      }
      console.log('  Added suppliers.credit_limit DECIMAL(14,2) DEFAULT 0.00');
    }

    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM suppliers');
    const [[{ set }]] = await pool.query('SELECT COUNT(*) AS `set` FROM suppliers WHERE credit_limit > 0');
    console.log(`\n${set} of ${n} suppliers have a credit limit set (expected 0 on a first run).`);
    console.log('Set them by hand on Master Lists > Suppliers; the Supplier page shows the limit,');
    console.log('the balance owed and what is left. Nothing refuses a PO that exceeds it.');
    await pool.end();
  } catch (err) {
    console.error(err);
    await pool.end();
    process.exit(1);
  }
})();
