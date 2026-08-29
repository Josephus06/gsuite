// Production Supervisor: who may run the production floor without holding can_edit on
// /production.
//
// Assembly Build and recording process completion previously required can_edit on
// /production, which the production accounts do not hold -- Anne and Velbeth sit on can_view
// only, so the Assembly Build button was drawn for them (it was gated on /job-orders can_edit)
// and then refused by the server. Handing them /production can_edit would also hand them RWIP
// and everything else that permission carries, so the capability is a per-user tag instead --
// the same shape as is_signage_planner and is_purchasing_supervisor.
//
// What they may act on is still bounded by their department's warehouse: assembly builds go
// through assertJobOrderInScope and process completion through the per-line location check, both
// off departments.job_location_id. This flag says "may work the floor", not "may work any floor".
const pool = require('../db');

async function colExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}

async function addFlag(column) {
  if (await colExists('users', column)) { console.log(`users.${column} exists`); return; }
  const ddl = `ALTER TABLE users ADD COLUMN ${column} TINYINT(1) NOT NULL DEFAULT 0`;
  try {
    await pool.query(`${ddl}, ALGORITHM=INSTANT`);
  } catch (err) {
    // ER_PARSE_ERROR only: a MySQL predating ALGORITHM=INSTANT. Anything else -- including the
    // server telling us this change cannot be instant -- is a real answer and must not be
    // retried as a full rebuild against a live table.
    if (err.errno !== 1064) throw err;
    console.log(`  (this MySQL has no ALGORITHM=INSTANT; adding ${column} the ordinary way)`);
    await pool.query(ddl);
  }
  console.log(`Added users.${column}`);
}

(async () => {
  try {
    await addFlag('is_production_supervisor');
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
