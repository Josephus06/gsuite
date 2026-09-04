// WHY Production cannot make the promised delivery date, picked from a fixed list.
//
// A delivery-date revision already carried the proposed date and an optional free-text remark,
// and the remark was doing two jobs at once: it was the only place the cause was ever recorded,
// and it was optional, so most revisions arrived with a new date and no explanation. Sales then
// had to decide whether to accept a slip without being told what caused it.
//
// A fixed list rather than more free text, because these are the answers the business already
// gives and they are worth counting: "how many jobs slipped for lack of material this quarter"
// is a question a column can answer and a paragraph cannot. The remark stays, for the detail
// the list cannot carry.
//
// Only meaningful for a delivery_date revision -- a material/process revision is a request to
// re-specify the job, and the reason for THAT is the spec change itself.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-revision-date-reason.js
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
    // Stores the CODE (lack_of_material, ...), not the label -- labels are presentation and are
    // mirrored in lib/jobOrderRevision.js and client/src/utils/salesRevision.js. 64 leaves room
    // for another code without a second migration.
    await addColumn('revision_date_reason', 'VARCHAR(64) NULL');

    const [[shape]] = await pool.query(
      `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'job_orders'
          AND column_name = 'revision_date_reason'`
    );
    console.log('Shape:', shape ? `${shape.type}, nullable ${shape.nullable}` : 'MISSING');
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
