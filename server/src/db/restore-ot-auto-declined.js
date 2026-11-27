// One-off repair (2026-11-27): put back to Approved the overtime requests the first OT auto-decline
// run (lib/otAutoDecline.js) declined wrongly --
//   * filed "for someone else" naming the filer (their own overtime; REQ-556), or
//   * declined before the employee had a whole day to answer (approved on or after the OT date's
//     end, e.g. REQ-2434 approved 15:34 and declined 15:39 the same day).
// The rest of that run stays declined. Dry run by default.
//
//   node src/db/restore-ot-auto-declined.js [--apply] [--user=<username>]   (default user: admin)
//
// Replicated set: run on ONE box (the droplet). Railway has its own database: run it there too.
const pool = require('../db');
require('dotenv').config();
const { UTC_OFFSET_MIN } = require('../lib/crmCadence');

const APPLY = process.argv.includes('--apply');
const USERNAME = (process.argv.find((a) => a.startsWith('--user=')) || '--user=admin').slice(7);

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`DB: ${db}${APPLY ? '' : ' -- DRY RUN (pass --apply to write)'}`);
  const [[user]] = await pool.query('SELECT id FROM users WHERE username = ?', [USERNAME]);
  if (!user) throw new Error(`No user ${USERNAME}`);
  const [rows] = await pool.query(
    `SELECT f.id, f.request_no, t.username AS target, (o.target_user_id = f.user_id) AS own,
            DATE_FORMAT(o.ot_date, '%Y-%m-%d') AS ot_date,
            DATE_FORMAT(f.approved_at + INTERVAL ? MINUTE, '%Y-%m-%d %H:%i') AS approved
       FROM form_requests f JOIN form_overtime_details o ON o.form_request_id = f.id
       JOIN users t ON t.id = o.target_user_id
      WHERE f.type = 'overtime' AND f.status = 'declined'
        AND o.response_remark LIKE 'Declined automatically:%'
        AND (o.target_user_id = f.user_id
             OR GREATEST(o.ot_date, DATE(f.approved_at + INTERVAL ? MINUTE)) >= DATE(o.responded_at + INTERVAL ? MINUTE))
      ORDER BY o.ot_date, f.id`, [UTC_OFFSET_MIN, UTC_OFFSET_MIN, UTC_OFFSET_MIN]);
  for (const r of rows) {
    console.log(`  ${r.request_no.padEnd(9)} ${r.target.padEnd(10)} OT ${r.ot_date}  approved ${r.approved}  ${r.own ? 'own overtime' : 'no full day to answer'}`);
  }
  console.log(`${rows.length} to restore to Approved.`);
  if (!APPLY || !rows.length) return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of rows) {
      await conn.query("UPDATE form_requests SET status = 'approved', updated_at = NOW() WHERE id = ? AND status = 'declined'", [r.id]);
      await conn.query('UPDATE form_overtime_details SET responded_at = NULL, response_remark = NULL WHERE form_request_id = ?', [r.id]);
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('FormRequest', ?, 'Status Change', 'Status', 'Declined', 'Approved', ?),
                ('FormRequest', ?, 'Updated', 'Response', 'Declined automatically', ?, ?)`,
        [r.id, user.id, r.id, `Restored: ${r.own ? 'filed for themselves' : 'not given a full day to answer'}`, user.id]);
    }
    await conn.commit();
    console.log('Restored.');
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
