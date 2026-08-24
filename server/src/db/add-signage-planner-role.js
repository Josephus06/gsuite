// Signage Planner: who may schedule a job order without being able to edit one.
//
// Scheduling on the production screen (Planned Start/End, then Acknowledge) previously
// required can_edit on /production, which today only General Manager and System Admin hold.
// Handing a planner that permission would also hand them every other production edit, so the
// capability is carried by a per-user tag instead -- the same shape as is_purchasing_supervisor,
// which gates PO approval without granting purchasing edit rights.
const pool = require('../db');

async function colExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}

async function addFlag(column) {
  if (await colExists('users', column)) { console.log(`users.${column} exists`); return; }
  await pool.query(`ALTER TABLE users ADD COLUMN ${column} TINYINT(1) NOT NULL DEFAULT 0`);
  console.log(`Added users.${column}`);
}

(async () => {
  try {
    await addFlag('is_signage_planner');
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
