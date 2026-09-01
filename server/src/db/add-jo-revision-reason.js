// Why Production sent a job order back, and what Sales is expected to do about it.
//
// "For Revision" carried no reason at all: the job order reappeared in Sales's queue with
// nothing saying what was wrong, so the two departments still had to talk before anything could
// happen -- the stage recorded that a problem existed, not what it was. The reason now decides
// what Sales may do:
//
//   material_process -- the spec is wrong. The owning sales rep may edit the job order's
//                       materials and processes for as long as it sits in revision.
//   delivery_date    -- Production cannot make it by the promised date and suggests another.
//                       Sales approves it (the date moves) or declines it (the date stands).
//                       Either way the job order goes straight back to Production.
//
// The suggestion and its outcome are columns rather than free text because both are acted on:
// approving one writes the date, and "who proposed which date, and what did Sales say" is the
// question asked afterwards when a job lands late.
const pool = require('../db');

async function colExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}

// Appended, never positioned, and INSTANT where the server supports it -- job_orders is 123k+
// rows on production and a rebuild would need an exclusive metadata lock and scratch disk.
async function addColumn(column, type) {
  if (await colExists('job_orders', column)) { console.log(`job_orders.${column} exists`); return; }
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
    await addColumn('revision_reason', 'VARCHAR(32) NULL');
    await addColumn('revision_note', 'VARCHAR(500) NULL');
    await addColumn('revision_suggested_delivery_date', 'DATE NULL');
    await addColumn('revision_requested_by_id', 'BIGINT NULL');
    await addColumn('revision_requested_at', 'DATETIME NULL');
    await addColumn('revision_date_decision', 'VARCHAR(16) NULL');
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
