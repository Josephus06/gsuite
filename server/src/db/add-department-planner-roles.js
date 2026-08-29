// One planner flag per production department, alongside the Signage Planner that already
// existed (db/add-signage-planner-role.js).
//
// The capability is identical in each case -- schedule a job order (Planned Start/End, then
// Acknowledge), work the floor, and read the Production module -- without holding can_edit on
// /production, which would also hand over RWIP and every other production edit. What differs is
// only WHICH work each planner sees, and that is not decided by the flag: it comes from their
// department's warehouse (departments.job_location_id), so a DPOD planner plans DPOD's job
// orders for exactly the same reason a Signage planner plans Signage's.
//
// Which is why these are four flags rather than one "is_planner": the flag is the job title on
// the account, and the four departments are staffed by different people. Every consumer treats
// them as a set -- see lib/plannerRoles.js, which is the single list.
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
    await addFlag('is_DPOD_planner');
    await addFlag('is_CNC_planner');
    await addFlag('is_LFP_planner');
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
