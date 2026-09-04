// "Advance Copy": letting Production SEE a job order before Sales has approved it.
//
// Production could not see a job order at all until Sales approved it and it was Released --
// production_stage stayed NULL, and the Production list is driven by that column. So the first
// time the floor heard about a job was the moment they were expected to schedule it, with no
// chance to notice that a material is not in stock and needs bringing in from another warehouse.
//
// Forwarding an advance copy makes the job VISIBLE there early and nothing more. Production may
// raise a Transfer Order against it -- the whole point, since that is how a short material gets
// moved -- and may do nothing else: no edit, no forecast dates, no Acknowledge, no Assembly
// Build, no Hold. Everything else unlocks when Sales approves and the job becomes Released /
// Pending for Scheduling.
//
// WHY A SEPARATE COLUMN RATHER THAN A NEW production_stage VALUE.
//
// production_stage is load-bearing in places that have nothing to do with this feature: the
// Saved Job Orders tabs on the Sales side put a JO in exactly one tab and the "Update JO"
// catch-all requires production_stage IS NULL (routes/jobOrders.js), the RWIP and RFQC lists
// define "open" in terms of it, and reworkJobOrder counts against it. Giving a pre-approval job
// order a stage would silently move it out of the Sales tab it belongs in -- a freshly created
// JO would land in no tab at all -- and would change three other modules by accident.
//
// A column leaves every one of those checks reading exactly what it reads today. An advance copy
// is `advance_copy_at IS NOT NULL AND production_stage IS NULL`, and the moment Sales approves,
// production_stage is set and the job stops being an advance copy without anything having to
// clear the flag. The Production list already has a tab that is not a stage value (Hold, on
// is_on_hold), so this follows a pattern that is already there.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-jo-advance-copy.js
const pool = require('../db');

async function colExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}

// Appended, never positioned, and INSTANT where the server supports it -- job_orders is 123k+
// rows on production and a rebuild would need an exclusive metadata lock and scratch disk.
async function addColumn(column, type) {
  if (await colExists('job_orders', column)) { console.log(`job_orders.${column} exists -- skipped.`); return; }
  const ddl = `ALTER TABLE job_orders ADD COLUMN ${column} ${type}`;
  try {
    await pool.query(`${ddl}, ALGORITHM=INSTANT`);
  } catch (err) {
    if (err.errno !== 1064) throw err;
    console.log(`  (this MySQL has no ALGORITHM=INSTANT; adding ${column} the ordinary way)`);
    await pool.query(ddl);
  }
  console.log(`Added job_orders.${column}`);
}

(async () => {
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
    await addColumn('advance_copy_at', 'DATETIME NULL');
    await addColumn('advance_copy_by_id', 'BIGINT NULL');

    const [shape] = await pool.query(
      `SELECT column_name AS name, column_type AS type, is_nullable AS nullable
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'job_orders'
          AND column_name IN ('advance_copy_at', 'advance_copy_by_id')
        ORDER BY column_name`
    );
    for (const c of shape) console.log(`Shape: ${c.name} ${c.type}, nullable ${c.nullable}`);
    if (shape.length !== 2) { console.error('EXPECTED BOTH COLUMNS'); process.exit(1); }

    const [[n]] = await pool.query(
      'SELECT COUNT(*) AS n FROM job_orders WHERE advance_copy_at IS NOT NULL'
    );
    console.log(`Advance copies currently flagged: ${n.n}`);
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
