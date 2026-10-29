const pool = require('../db');
const { insertFor, usersWithPermission } = require('./approvalNotifications');

// An ARTIST who declines three overtime requests in a row within one month is charged automatically
// (asked 2026-10-29): a Violation and its Incident Report land in HR's queue, as if filed from
// HRD > Violations, under the violation db/add-ot-decline-ir.js chose (app_settings
// 'ot_decline_violation_type_id').
//
// "In a row" is the artist's answered overtime requests for that month -- accepted or declined -- in
// date order: three declines with no accept between them. Each decline counts once
// (form_overtime_details.decline_violation_id), so a fourth decline does not raise a second report,
// and a sixth raises the next. Called after the decline is saved; a failure is logged, never
// thrown -- the decline stands either way.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RUN = 3;

async function checkOtDeclines(formId, actorId) {
  try {
    const [[d]] = await pool.query(
      `SELECT o.target_user_id, DATE_FORMAT(o.ot_date, '%Y-%m-%d') AS ot_date, u.account_type, u.employee_id
         FROM form_overtime_details o JOIN users u ON u.id = o.target_user_id
        WHERE o.form_request_id = ? AND o.for_self = 0`, [formId]);
    if (!d || String(d.account_type || '').toLowerCase() !== 'artist' || !d.employee_id || !d.ot_date) return null;
    const [[setting]] = await pool.query("SELECT value FROM app_settings WHERE name = 'ot_decline_violation_type_id'").catch(() => [[null]]);
    if (!setting) { console.warn('[ot-decline-ir] no violation set -- run src/db/add-ot-decline-ir.js'); return null; }

    const month = d.ot_date.slice(0, 7);
    const [answered] = await pool.query(
      `SELECT f.id, f.request_no, f.status, DATE_FORMAT(o.ot_date, '%Y-%m-%d') AS ot_date, o.response_remark, o.decline_violation_id
         FROM form_requests f JOIN form_overtime_details o ON o.form_request_id = f.id
        WHERE o.target_user_id = ? AND o.for_self = 0 AND f.status IN ('accepted', 'declined')
          AND DATE_FORMAT(o.ot_date, '%Y-%m') = ?
        ORDER BY o.ot_date, o.responded_at, f.id`, [d.target_user_id, month]);
    // The run of declines this one sits in, and those of it not yet counted into a charge.
    const at = answered.findIndex((r) => Number(r.id) === Number(formId));
    if (at < 0 || answered[at].status !== 'declined') return null;
    let a = at; while (a > 0 && answered[a - 1].status === 'declined') a -= 1;
    let b = at; while (b < answered.length - 1 && answered[b + 1].status === 'declined') b += 1;
    const free = answered.slice(a, b + 1).filter((r) => !r.decline_violation_id);
    if (free.length < RUN) return null;
    const counted = free.slice(0, RUN);

    const [[type]] = await pool.query('SELECT id, name, category, severity, is_active FROM hr_violation_types WHERE id = ?', [Number(setting.value)]);
    if (!type) { console.warn(`[ot-decline-ir] violation #${setting.value} not found`); return null; }
    const [[emp]] = await pool.query(
      `SELECT e.id, e.employee_code, CONCAT_WS(' ', e.first_name, e.last_name) AS employee_name, e.position_title, dp.name AS department_name
         FROM employees e LEFT JOIN departments dp ON dp.id = e.department_id WHERE e.id = ?`, [d.employee_id]);
    if (!emp) return null;

    const [y, m] = month.split('-').map(Number);
    const details = `Declined ${RUN} overtime requests in a row in ${MONTHS[m - 1]} ${y}:\n`
      + counted.map((r) => `- ${r.request_no} (${r.ot_date})${r.response_remark ? `: ${r.response_remark}` : ''}`).join('\n')
      + '\n\nFiled automatically by T1S.';
    const conn = await pool.getConnection();
    let result;
    try {
      await conn.beginTransaction();
      const [v] = await conn.query(
        `INSERT INTO hr_violations
           (employee_id, violation_type_id, employee_name, employee_code, department_name, position_title,
            violation_name, violation_category, violation_severity, violation_date, place, details, reported_by_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,NULL)`,
        [emp.id, type.id, emp.employee_name, emp.employee_code, emp.department_name, emp.position_title,
          type.name, type.category, type.severity, counted[counted.length - 1].ot_date, details]);
      await conn.query('UPDATE hr_violations SET violation_no = ? WHERE id = ?', [`VIO-${v.insertId}`, v.insertId]);
      const [ir] = await conn.query('INSERT INTO hr_incident_reports (violation_id) VALUES (?)', [v.insertId]);
      await conn.query('UPDATE hr_incident_reports SET incident_no = ? WHERE id = ?', [`IR-${ir.insertId}`, ir.insertId]);
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('IncidentReport', ?, 'Created', 'incident_no', NULL, ?, ?)`, [ir.insertId, `IR-${ir.insertId} (automatic: ${RUN} declined overtime)`, actorId || d.target_user_id]);
      await conn.query('UPDATE form_overtime_details SET decline_violation_id = ? WHERE form_request_id IN (?)', [v.insertId, counted.map((r) => r.id)]);
      await conn.commit();
      result = { violationId: v.insertId, irId: ir.insertId, irNo: `IR-${ir.insertId}` };
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

    // HR, who evaluate it.
    const hr = await usersWithPermission('/hrd/incident-reports', 'can_edit');
    await insertFor(hr, {
      type: 'incident_report', relatedType: 'IncidentReport', relatedId: result.irId,
      title: `${result.irNo}: ${emp.employee_name} declined ${RUN} overtime requests`,
      message: `Filed automatically -- ${counted.map((r) => r.request_no).join(', ')} (${MONTHS[m - 1]} ${y}).`,
    }, null);
    console.log(`[ot-decline-ir] ${result.irNo} for ${emp.employee_name}: ${counted.map((r) => r.request_no).join(', ')}`);
    return result;
  } catch (e) {
    console.error('[ot-decline-ir]', e.message);
    return null;
  }
}

module.exports = { checkOtDeclines };
