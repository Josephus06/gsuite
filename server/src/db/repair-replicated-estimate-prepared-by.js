// Prepared By on a replicated estimate is the person who replicated it (fa0553e, 2026-10-03). Replicas
// made before that reached the servers still carry the SOURCE estimate's preparer, or none. This
// sets them to the replicating user's employee, read from the estimate's 'replicated_from' audit row
// (asked 2026-10-05).
//
// Left alone, and named: a replicator with no employee, and any estimate whose Prepared By was
// changed by hand after it was made (an audited prepared_by_id edit) -- that choice was deliberate.
// The estimate only: a Sales Order already raised from it keeps its own copy of the header.
// Dry run unless --apply; --apply writes a rollback file of old values.
// Production: the droplet only (replication carries it to the office).
//
//   node src/db/repair-replicated-estimate-prepared-by.js [--apply]
//   node src/db/repair-replicated-estimate-prepared-by.js --rollback=rollback/replica-prepared-by-rollback-<stamp>.json
const fs = require('fs');
const path = require('path');
const pool = require('../db');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const ROLLBACK = (process.argv.find((a) => a.startsWith('--rollback=')) || '').split('=')[1];

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- DRY RUN, nothing written'}`);
  if (ROLLBACK) {
    const rb = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    for (const r of rb) await pool.query('UPDATE estimates SET prepared_by_id = ? WHERE id = ?', [r.prepared_by_id, r.id]);
    console.log(`Rolled back ${rb.length} estimate(s).`);
    return;
  }

  const [rows] = await pool.query(
    `SELECT e.id, e.estimate_no, e.prepared_by_id, a.new_value AS replicated_from,
            u.username, u.employee_id AS replicator_emp,
            CONCAT(was.first_name, ' ', was.last_name) AS was_name,
            CONCAT(rep.first_name, ' ', rep.last_name) AS replicator_name,
            EXISTS (SELECT 1 FROM audit_logs h WHERE h.auditable_type = 'Estimate' AND h.auditable_id = e.id
                     AND h.field_name = 'prepared_by_id') AS hand_edited,
            EXISTS (SELECT 1 FROM sales_orders so WHERE so.estimate_id = e.id) AS has_so
     FROM audit_logs a
     JOIN estimates e ON e.id = a.auditable_id
     LEFT JOIN users u ON u.id = a.set_by_user_id
     LEFT JOIN employees was ON was.id = e.prepared_by_id
     LEFT JOIN employees rep ON rep.id = u.employee_id
     WHERE a.auditable_type = 'Estimate' AND a.field_name = 'replicated_from'
       AND NOT (e.prepared_by_id <=> u.employee_id)
     ORDER BY e.id`
  );

  const plan = []; const skipped = [];
  for (const r of rows) {
    if (!r.replicator_emp) { skipped.push(`${r.estimate_no}: replicated by ${r.username || 'unknown user'}, who has no employee`); continue; }
    if (r.hand_edited) { skipped.push(`${r.estimate_no}: Prepared By was changed by hand after it was made`); continue; }
    plan.push(r);
  }
  console.log(`Replicas whose Prepared By is not the replicator: ${rows.length}; to correct: ${plan.length}; skipped ${skipped.length}`);
  for (const p of plan) {
    console.log(`  ${p.estimate_no} (from ${p.replicated_from}): "${p.was_name || '(none)'}" -> "${p.replicator_name}"${p.has_so ? '  [has a Sales Order, which keeps its own]' : ''}`);
  }
  for (const s of skipped) console.log(`  SKIP ${s}`);
  if (!APPLY) return;

  const rollback = [];
  const outDir = path.join(__dirname, '..', '..', 'rollback'); fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `replica-prepared-by-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const p of plan) {
      const [[row]] = await conn.query('SELECT id, prepared_by_id FROM estimates WHERE id = ? FOR UPDATE', [p.id]);
      if (!row || row.prepared_by_id !== p.prepared_by_id) continue; // changed since it was read
      rollback.push(row);
      await conn.query('UPDATE estimates SET prepared_by_id = ? WHERE id = ?', [p.replicator_emp, p.id]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  fs.writeFileSync(file, JSON.stringify(rollback));
  console.log(`Corrected ${rollback.length} estimate(s). Rollback: ${file}`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
