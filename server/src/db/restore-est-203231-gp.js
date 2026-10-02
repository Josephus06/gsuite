// One-off: put EST-203231's GP back to the figures it was replicated with (from EST-109917).
//
// On 2026-10-02 its lines and header were recalculated from the process lines' Total Cost. That
// was wrong for this estimate: its processes came from a migrated estimate, whose cost fields hold
// the source system's rates, not costs, so the recalculated 48.03% meant nothing. These are the
// values it held before (read off the database before the change).
//
//   node src/db/restore-est-203231-gp.js            dry run
//   node src/db/restore-est-203231-gp.js --apply
//
// Run on ONE box of the droplet/office pair; replication carries it to the other.
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const ESTIMATE_NO = 'EST-203231';
const LINES = { 1: [64.16, 46194.96], 2: [70.50, 4582.68], 3: [61.88, 56731.39], 4: [74.03, 5551.95] };
const HEADER = { est_gp_rate: 63.63, est_gp_amount: 113060.98 };

(async () => {
  const [[e]] = await pool.query('SELECT id, status, est_gp_rate FROM estimates WHERE estimate_no = ?', [ESTIMATE_NO]);
  if (!e) throw new Error(`${ESTIMATE_NO} not found`);
  const [now] = await pool.query('SELECT line_no, gp_rate, gp_amount FROM estimate_job_orders WHERE estimate_id = ? ORDER BY line_no', [e.id]);
  console.log(`${ESTIMATE_NO} (${e.status}) now: overall ${e.est_gp_rate}%, lines ${now.map((l) => `${l.gp_rate}%`).join(', ')}`);
  console.log(`will set:    overall ${HEADER.est_gp_rate}%, lines ${Object.values(LINES).map(([r]) => `${r}%`).join(', ')}`);
  if (!APPLY) { console.log('DRY RUN -- nothing written. Re-run with --apply.'); return; }

  const [[admin]] = await pool.query(
    "SELECT id FROM users WHERE username = 'admin' OR account_type = 'System Admin' ORDER BY (username = 'admin') DESC, id LIMIT 1");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [lineNo, [rate, amount]] of Object.entries(LINES)) {
      await conn.query('UPDATE estimate_job_orders SET gp_rate = ?, gp_amount = ? WHERE estimate_id = ? AND line_no = ?',
        [rate, amount, e.id, Number(lineNo)]);
    }
    await conn.query('UPDATE estimates SET est_gp_rate = ?, est_gp_amount = ? WHERE id = ?', [HEADER.est_gp_rate, HEADER.est_gp_amount, e.id]);
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('Estimate', ?, 'Updated', 'est_gp_rate', ?, ?, ?)`,
      [e.id, String(e.est_gp_rate), String(HEADER.est_gp_rate), admin.id]);
    await conn.commit();
    console.log('Restored.');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
})()
  .catch((err) => { console.error('FAILED:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
