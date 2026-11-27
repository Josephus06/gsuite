// An overtime request filed for someone else that the employee has not answered by the end of its
// OT date is declined automatically (asked 2026-11-27): filed today for tonight, not accepted
// today -> Declined tomorrow. Runs just after midnight business time (Philippine), and once when the
// server starts so a box that was down at midnight still catches up.
//
// Only requests waiting on the employee (status 'approved', for_self = 0). One still waiting on noting
// or approval is left alone -- the employee could not answer it yet.
//
// The decline is recorded as the employee's (set_by_user_id = the employee; audit_logs needs a user),
// with the response remark saying it was automatic. It counts like any other decline, including the
// artists' three-declines-in-a-row Incident Report (lib/otDeclineIr.js).
//
// OFF unless OT_AUTO_DECLINE_JOB=1 -- set it on ONE box of the replicated set (the droplet) and on
// Railway; two boxes declining the same row would collide in replication.
const pool = require('../db');
const { businessToday, msUntilBusinessTime } = require('./crmCadence');
const { notifyFormStatus } = require('./approvalNotifications');
const { checkOtDeclines } = require('./otDeclineIr');

const otAutoDeclineJobEnabled = () => String(process.env.OT_AUTO_DECLINE_JOB || '') === '1';
const REMARK = 'Declined automatically: not accepted by the end of the overtime date.';

async function autoDeclineUnansweredOvertime() {
  const today = businessToday();
  const [rows] = await pool.query(
    `SELECT f.id, o.target_user_id
       FROM form_requests f JOIN form_overtime_details o ON o.form_request_id = f.id
      WHERE f.type = 'overtime' AND f.status = 'approved' AND o.for_self = 0 AND o.ot_date < ?`, [today]);
  let declined = 0;
  for (const r of rows) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Re-checked under the row's status, so an answer that lands in between wins.
      const [u] = await conn.query(
        "UPDATE form_requests SET status = 'declined', updated_at = NOW() WHERE id = ? AND status = 'approved'", [r.id]);
      if (!u.affectedRows) { await conn.rollback(); continue; }
      await conn.query('UPDATE form_overtime_details SET responded_at = NOW(), response_remark = ? WHERE form_request_id = ?', [REMARK, r.id]);
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('FormRequest', ?, 'Status Change', 'Status', 'Approved', 'Declined', ?),
                ('FormRequest', ?, 'Updated', 'Response', NULL, ?, ?)`,
        [r.id, r.target_user_id, r.id, REMARK, r.target_user_id]);
      await conn.commit();
      declined += 1;
    } catch (err) {
      try { await conn.rollback(); } catch { /* already done */ }
      console.error(`OT auto-decline: form #${r.id} failed:`, err.message);
      continue;
    } finally {
      conn.release();
    }
    notifyFormStatus(r.id, r.target_user_id);
    await checkOtDeclines(r.id, r.target_user_id);
  }
  return { waiting: rows.length, declined, before: today };
}

function scheduleOtAutoDecline(hour = 0, minute = 10) {
  const run = async () => {
    try {
      const res = await autoDeclineUnansweredOvertime();
      if (res.declined) console.log(`OT auto-decline: ${res.declined} unanswered overtime request(s) dated before ${res.before} declined.`);
    } catch (err) {
      if (err.code !== 'ER_NO_SUCH_TABLE') console.error('OT auto-decline failed:', err);
    }
  };
  const next = () => setTimeout(async () => { await run(); next(); }, msUntilBusinessTime(hour, minute));
  setTimeout(run, 30 * 1000).unref();
  next();
}

module.exports = { otAutoDeclineJobEnabled, autoDeclineUnansweredOvertime, scheduleOtAutoDecline };
