const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// HRD > Violation. Charging an employee under the company's own code of conduct.
//
// Mounted at /api/hr-violations rather than under /api/hrd. The HRD router already owns /:id for
// document rooms, and Express matches in declaration order -- /api/hrd/violations would be read as
// a room with the id "violations".
const ROUTE = '/hrd/violations';
// Evaluating the report it raises is a different job for different people, so the incident-report
// side has its own page. Referenced here because saving a charge writes a row HR then owns.
const IR_ROUTE = '/hrd/incident-reports';

const SEVERITIES = ['minor', 'major', 'grave'];
const trunc = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));

// --- the lookup ---------------------------------------------------------------------------
//
// Every violation an employee may be charged with. Kept by HR; starts empty, because a company's
// list of offences is its code of conduct and inventing entries would let somebody be charged
// under a rule that was never adopted.

router.get('/types', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const includeInactive = req.query.include_inactive === '1';
    const [rows] = await pool.query(
      `SELECT t.id, t.code, t.name, t.category, t.severity, t.description, t.is_active, t.sort_order,
              (SELECT COUNT(*) FROM hr_violations v WHERE v.violation_type_id = t.id) AS times_charged
         FROM hr_violation_types t
        ${includeInactive ? '' : 'WHERE t.is_active = TRUE'}
        ORDER BY t.is_active DESC, t.sort_order, t.category, t.name`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

function readType(body) {
  const name = trunc(body.name, 150);
  if (!name) return { error: 'A violation name is required.' };
  const severity = SEVERITIES.includes(body.severity) ? body.severity : 'minor';
  return {
    name,
    severity,
    code: trunc(body.code, 30),
    category: trunc(body.category, 60),
    description: trunc(body.description, 1000),
    sortOrder: Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0,
  };
}

router.post('/types', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const t = readType(req.body);
    if (t.error) return res.status(400).json({ error: t.error });
    const [[dupe]] = await pool.query('SELECT id FROM hr_violation_types WHERE name = ?', [t.name]);
    if (dupe) return res.status(400).json({ error: `"${t.name}" is already on the violation list.` });
    const [r] = await pool.query(
      `INSERT INTO hr_violation_types (code, name, category, severity, description, sort_order)
       VALUES (?,?,?,?,?,?)`,
      [t.code, t.name, t.category, t.severity, t.description, t.sortOrder],
    );
    return res.status(201).json({ id: r.insertId });
  } catch (err) { return next(err); }
});

router.put('/types/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const t = readType(req.body);
    if (t.error) return res.status(400).json({ error: t.error });
    const [[dupe]] = await pool.query(
      'SELECT id FROM hr_violation_types WHERE name = ? AND id <> ?', [t.name, req.params.id]);
    if (dupe) return res.status(400).json({ error: `"${t.name}" is already on the violation list.` });
    const [r] = await pool.query(
      `UPDATE hr_violation_types SET code = ?, name = ?, category = ?, severity = ?, description = ?,
              sort_order = ?, is_active = ?, updated_at = NOW() WHERE id = ?`,
      [t.code, t.name, t.category, t.severity, t.description, t.sortOrder,
        req.body.is_active === false ? 0 : 1, req.params.id],
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// Retired rather than deleted once it has been used. Deleting an offence somebody was charged
// under would leave that charge citing nothing, and disciplinary records are read years later.
router.delete('/types/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[used]] = await pool.query(
      'SELECT COUNT(*) AS n FROM hr_violations WHERE violation_type_id = ?', [req.params.id]);
    if (used.n) {
      await pool.query('UPDATE hr_violation_types SET is_active = FALSE, updated_at = NOW() WHERE id = ?',
        [req.params.id]);
      return res.json({ ok: true, retired: true, charges: used.n });
    }
    const [r] = await pool.query('DELETE FROM hr_violation_types WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true, retired: false });
  } catch (err) { return next(err); }
});

// --- employee search ----------------------------------------------------------------------
//
// "Search the employee name then select the violation." Name, code and department all match, since
// a supervisor filing a report may know any one of them.
router.get('/employees', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const q = String(req.query.search || '').trim();
    const params = [];
    const where = ['e.is_active = 1'];
    if (q) {
      where.push(`(CONCAT_WS(' ', e.first_name, e.last_name) LIKE ?
                   OR e.employee_code LIKE ? OR d.name LIKE ? OR e.position_title LIKE ?)`);
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const [rows] = await pool.query(
      `SELECT e.id, e.employee_code, CONCAT_WS(' ', e.first_name, e.last_name) AS employee_name,
              e.position_title, d.name AS department_name,
              (SELECT COUNT(*) FROM hr_violations v WHERE v.employee_id = e.id) AS prior_violations
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
        WHERE ${where.join(' AND ')}
        ORDER BY employee_name
        LIMIT 50`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// One employee's disciplinary history. What HR reads before deciding what a fresh charge means --
// a first offence and a fourth are not the same thing.
router.get('/employees/:id/history', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT v.id, v.violation_no, v.violation_date, v.violation_name, v.violation_severity, v.status,
              ir.incident_no, ir.status AS incident_status, ir.recommendation
         FROM hr_violations v
         LEFT JOIN hr_incident_reports ir ON ir.violation_id = v.id
        WHERE v.employee_id = ?
        ORDER BY v.violation_date DESC, v.id DESC`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// --- the charge ---------------------------------------------------------------------------

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (req.query.employee_id) { where.push('v.employee_id = ?'); params.push(req.query.employee_id); }
    if (req.query.severity) { where.push('v.violation_severity = ?'); params.push(req.query.severity); }
    if (req.query.from) { where.push('v.violation_date >= ?'); params.push(req.query.from); }
    if (req.query.to) { where.push('v.violation_date <= ?'); params.push(req.query.to); }
    if (req.query.search) {
      where.push('(v.violation_no LIKE ? OR v.employee_name LIKE ? OR v.violation_name LIKE ? OR v.employee_code LIKE ?)');
      const q = `%${req.query.search}%`;
      params.push(q, q, q, q);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT v.id, v.violation_no, v.violation_date, v.employee_name, v.employee_code,
              v.department_name, v.violation_name, v.violation_category, v.violation_severity,
              v.status, u.display_name AS reported_by_name,
              ir.id AS incident_report_id, ir.incident_no, ir.status AS incident_status
         FROM hr_violations v
         LEFT JOIN users u ON u.id = v.reported_by_user_id
         LEFT JOIN hr_incident_reports ir ON ir.violation_id = v.id
         ${whereSql}
        ORDER BY v.violation_date DESC, v.id DESC
        LIMIT 500`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[v]] = await pool.query(
      `SELECT v.*, u.display_name AS reported_by_name,
              ir.id AS incident_report_id, ir.incident_no, ir.status AS incident_status,
              ir.hr_findings, ir.recommendation, ir.recommendation_notes, ir.evaluated_at,
              eu.display_name AS evaluated_by_name
         FROM hr_violations v
         LEFT JOIN users u ON u.id = v.reported_by_user_id
         LEFT JOIN hr_incident_reports ir ON ir.violation_id = v.id
         LEFT JOIN users eu ON eu.id = ir.evaluated_by_user_id
        WHERE v.id = ?`, [req.params.id],
    );
    if (!v) return res.status(404).json({ error: 'Not found' });

    // The employee's other charges, so whoever opens this sees the pattern rather than one act.
    const [history] = await pool.query(
      `SELECT id, violation_no, violation_date, violation_name, violation_severity
         FROM hr_violations WHERE employee_id = ? AND id <> ?
        ORDER BY violation_date DESC LIMIT 20`,
      [v.employee_id, v.id],
    );
    return res.json({ ...v, history });
  } catch (err) { return next(err); }
});

// Charging an employee. This is the action the whole module exists for, and it writes TWO rows:
// the charge, and the Incident Report that puts it in HR's queue. Both or neither -- a charge with
// no report would sit unevaluated forever, and a report with no charge cites nothing.
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const employeeId = Number(req.body.employee_id);
    const typeId = Number(req.body.violation_type_id);
    if (!employeeId) return res.status(400).json({ error: 'Choose the employee being charged.' });
    if (!typeId) return res.status(400).json({ error: 'Choose the violation.' });
    const violationDate = req.body.violation_date;
    if (!violationDate) return res.status(400).json({ error: 'Enter the date the violation happened.' });

    const [[emp]] = await conn.query(
      `SELECT e.id, e.employee_code, CONCAT_WS(' ', e.first_name, e.last_name) AS employee_name,
              e.position_title, e.is_active, d.name AS department_name
         FROM employees e LEFT JOIN departments d ON d.id = e.department_id
        WHERE e.id = ?`, [employeeId],
    );
    if (!emp) return res.status(400).json({ error: 'Unknown employee.' });
    if (!emp.is_active) return res.status(400).json({ error: `${emp.employee_name} is no longer an active employee.` });

    const [[type]] = await conn.query(
      'SELECT id, name, category, severity, is_active FROM hr_violation_types WHERE id = ?', [typeId]);
    if (!type) return res.status(400).json({ error: 'Unknown violation.' });
    if (!type.is_active) return res.status(400).json({ error: `"${type.name}" is no longer in use.` });

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO hr_violations
         (employee_id, violation_type_id, employee_name, employee_code, department_name, position_title,
          violation_name, violation_category, violation_severity, violation_date, place, details,
          reported_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [employeeId, typeId, emp.employee_name, emp.employee_code, emp.department_name, emp.position_title,
        type.name, type.category, type.severity, violationDate,
        trunc(req.body.place, 200), trunc(req.body.details, 4000), req.user.id],
    );
    const violationId = r.insertId;
    await conn.query('UPDATE hr_violations SET violation_no = ? WHERE id = ?', [`VIO-${violationId}`, violationId]);

    const [ir] = await conn.query(
      'INSERT INTO hr_incident_reports (violation_id) VALUES (?)', [violationId]);
    await conn.query('UPDATE hr_incident_reports SET incident_no = ? WHERE id = ?', [`IR-${ir.insertId}`, ir.insertId]);

    await conn.commit();
    return res.status(201).json({
      id: violationId,
      violation_no: `VIO-${violationId}`,
      incident_report_id: ir.insertId,
      incident_no: `IR-${ir.insertId}`,
    });
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

// Correcting the account of what happened. The employee and the offence are NOT editable: those
// are what the incident report cites, and changing them under an evaluation in progress would mean
// HR ruling on a different charge from the one they read. File a new one and delete this instead.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const fields = [];
    const params = [];
    if (req.body.violation_date) { fields.push('violation_date = ?'); params.push(req.body.violation_date); }
    if (req.body.place !== undefined) { fields.push('place = ?'); params.push(trunc(req.body.place, 200)); }
    if (req.body.details !== undefined) { fields.push('details = ?'); params.push(trunc(req.body.details, 4000)); }
    if (!fields.length) return res.json({ ok: true });
    fields.push('updated_at = NOW()');
    params.push(req.params.id);
    const [r] = await pool.query(`UPDATE hr_violations SET ${fields.join(', ')} WHERE id = ?`, params);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// Withdrawing a charge takes its incident report with it -- an evaluated one will not go, because
// that is a decision on somebody's record, not a draft.
router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[ir]] = await conn.query(
      'SELECT id, status, evaluated_at FROM hr_incident_reports WHERE violation_id = ?', [req.params.id]);
    if (ir && ir.evaluated_at) {
      return res.status(409).json({
        error: `${ir.status === 'dismissed' ? 'This charge was dismissed' : 'HR has already evaluated this charge'}, so it cannot be withdrawn.`,
      });
    }
    await conn.beginTransaction();
    await conn.query('DELETE FROM hr_incident_reports WHERE violation_id = ?', [req.params.id]);
    const [r] = await conn.query('DELETE FROM hr_violations WHERE id = ?', [req.params.id]);
    await conn.commit();
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
module.exports.IR_ROUTE = IR_ROUTE;
