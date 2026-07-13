const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/scheduled-jo';

async function logAudit(conn, { processId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('JobOrderProcess', ?, ?, ?, ?, ?, ?)`,
    [processId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Ownership check shared by start/hold/finish -- only the assigned production employee
// can drive their own clock. Never relaxed for supervisors/admins -- the clock belongs
// to whoever is actually doing the work, even though they can view it read-only.
async function getOwnedProcess(conn, processId, userId) {
  const [[me]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [userId]);
  const [[proc]] = await conn.query(
    'SELECT id, job_order_id, assigned_employee_id, assignment_started_at, assignment_ended_at FROM job_order_processes WHERE id = ?',
    [processId]
  );
  if (!proc) return { error: [404, 'Not found'] };
  if (!me?.employee_id || proc.assigned_employee_id !== me.employee_id) {
    return { error: [403, 'This process is not assigned to you.'] };
  }
  return { proc };
}

// A production-department employee gets the personal-worklist view (their own
// assignments only). Anyone else with access to this page -- a department supervisor,
// admin -- isn't themselves a valid assignee, so they instead get the scheduling
// overview: every currently in-process Job Order, opened to assign staff per task.
async function isProductionEmployee(employeeId) {
  if (!employeeId) return false;
  const [[row]] = await pool.query(
    `SELECT e.id FROM employees e JOIN departments d ON d.id = e.department_id
     WHERE e.id = ? AND d.name LIKE 'Production%'`,
    [employeeId]
  );
  return !!row;
}

// Feeds the "Assigned To" picker -- scoped to Production-department employees, same
// list as Production module's own picker. Registered ahead of the /:jobOrderId param
// route so "production-employees" isn't swallowed as a jobOrderId value.
router.get('/production-employees', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.id, e.first_name, e.last_name, e.position_title, d.name AS department_name
       FROM employees e JOIN departments d ON d.id = e.department_id
       WHERE d.name LIKE 'Production%' AND e.is_active = TRUE
       ORDER BY e.first_name, e.last_name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Landing list: a production employee sees their own personal task worklist (mode:
// 'tasks'); anyone else (a department supervisor, admin) sees every in-process Job
// Order instead (mode: 'jobs') -- opening one takes them to the Task table to assign
// staff per process line, matching the real system's Scheduled JO screen.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    const mine = await isProductionEmployee(me?.employee_id);

    if (mine) {
      const [rows] = await pool.query(
        `SELECT jop.id, jop.total, jop.assignment_started_at, jop.assignment_ended_at,
                pr.process_name, pr.minutes_per_unit,
                COALESCE(jop.total, 0) * COALESCE(pr.minutes_per_unit, 0) AS allotted_minutes,
                jo.id AS job_order_id, jo.job_order_no, jo.description,
                c.name AS customer_name,
                EXISTS(SELECT 1 FROM job_order_process_sessions s WHERE s.job_order_process_id = jop.id AND s.ended_at IS NULL) AS is_running
         FROM job_order_processes jop
         JOIN job_orders jo ON jo.id = jop.job_order_id
         LEFT JOIN processes pr ON pr.id = jop.process_id
         LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
         LEFT JOIN customers c ON c.id = so.customer_id
         WHERE jop.assigned_employee_id = ?
         ORDER BY jop.id DESC`,
        [me.employee_id]
      );
      return res.json({ mode: 'tasks', rows: rows.map((r) => ({ ...r, is_running: !!r.is_running })) });
    }

    const [rows] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.description, jo.quantity, jo.units, jo.delivery_date,
              loc.location_name AS job_location_name, c.name AS customer_name,
              (SELECT COUNT(*) FROM job_order_processes p WHERE p.job_order_id = jo.id) AS task_count,
              (SELECT COUNT(*) FROM job_order_processes p WHERE p.job_order_id = jo.id AND p.assigned_employee_id IS NOT NULL) AS assigned_count
       FROM job_orders jo
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       WHERE jo.production_stage = 'in_process'
       ORDER BY jo.id DESC`
    );
    res.json({ mode: 'jobs', rows });
  } catch (err) {
    next(err);
  }
});

// Task table for one Job Order -- the supervisor's assignment screen. Self-contained
// under this module's own permission (doesn't require Production module access).
router.get('/:jobOrderId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[jo]] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.description, jo.quantity, jo.units, jo.delivery_date, jo.production_stage,
              loc.location_name AS job_location_name, c.name AS customer_name
       FROM job_orders jo
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       WHERE jo.id = ?`,
      [req.params.jobOrderId]
    );
    if (!jo) return res.status(404).json({ error: 'Not found' });

    const [tasks] = await pool.query(
      `SELECT jop.id, jop.qty, jop.unit, jop.total, jop.process_cost, jop.material_cost,
              jop.assigned_employee_id, jop.assignment_started_at, jop.assignment_ended_at,
              pr.process_name, pr.minutes_per_unit, loc.location_name, i.display_name AS item_name,
              COALESCE(jop.total, 0) * COALESCE(pr.minutes_per_unit, 0) AS allotted_minutes,
              CONCAT(ae.first_name, ' ', ae.last_name) AS assigned_employee_name,
              EXISTS(SELECT 1 FROM job_order_process_sessions s WHERE s.job_order_process_id = jop.id AND s.ended_at IS NULL) AS is_running
       FROM job_order_processes jop
       LEFT JOIN processes pr ON pr.id = jop.process_id
       LEFT JOIN locations loc ON loc.id = jop.location_id
       LEFT JOIN inventories i ON i.id = jop.item_id
       LEFT JOIN employees ae ON ae.id = jop.assigned_employee_id
       WHERE jop.job_order_id = ? ORDER BY jop.line_no`,
      [req.params.jobOrderId]
    );

    res.json({ ...jo, tasks: tasks.map((t) => ({ ...t, is_running: !!t.is_running })) });
  } catch (err) {
    next(err);
  }
});

// Assigning (or clearing, when employee_id is falsy) who will run a task/process line.
router.put('/:jobOrderId/tasks/:processId/assign', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const employeeId = req.body.employee_id || null;
    if (employeeId) {
      const [[emp]] = await pool.query(
        `SELECT e.id FROM employees e JOIN departments d ON d.id = e.department_id
         WHERE e.id = ? AND d.name LIKE 'Production%'`,
        [employeeId]
      );
      if (!emp) return res.status(400).json({ error: 'That employee is not in a Production department.' });
    }
    const [result] = await pool.query(
      'UPDATE job_order_processes SET assigned_employee_id = ? WHERE id = ? AND job_order_id = ?',
      [employeeId, req.params.processId, req.params.jobOrderId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ assigned_employee_id: employeeId });
  } catch (err) {
    next(err);
  }
});

// Single process detail for the assignee's "run" screen -- includes the full Play/Hold
// session log. Viewable by the assignee (their own, with full controls) or by anyone
// with the supervisory overview (read-only -- Play/Hold/Stop stay owner-only via
// getOwnedProcess). Registered ahead of /:jobOrderId so "process" isn't swallowed as a
// jobOrderId value.
router.get('/process/:processId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    const [[row]] = await pool.query(
      `SELECT jop.id, jop.total, jop.assigned_employee_id, jop.assignment_started_at, jop.assignment_ended_at,
              pr.process_name, pr.minutes_per_unit,
              COALESCE(jop.total, 0) * COALESCE(pr.minutes_per_unit, 0) AS allotted_minutes,
              jo.id AS job_order_id, jo.job_order_no, jo.description,
              c.name AS customer_name,
              CONCAT(ae.first_name, ' ', ae.last_name) AS assigned_employee_name
       FROM job_order_processes jop
       JOIN job_orders jo ON jo.id = jop.job_order_id
       LEFT JOIN processes pr ON pr.id = jop.process_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees ae ON ae.id = jop.assigned_employee_id
       WHERE jop.id = ?`,
      [req.params.processId]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    const isOwner = !!me?.employee_id && row.assigned_employee_id === me.employee_id;
    if (!isOwner && await isProductionEmployee(me?.employee_id)) {
      return res.status(403).json({ error: 'This process is not assigned to you.' });
    }
    if (!row.assigned_employee_id) return res.status(404).json({ error: 'Not found' });

    const [sessions] = await pool.query(
      'SELECT id, started_at, ended_at FROM job_order_process_sessions WHERE job_order_process_id = ? ORDER BY started_at ASC',
      [req.params.processId]
    );

    res.json({ ...row, sessions, is_owner: isOwner });
  } catch (err) {
    next(err);
  }
});

// "Play" -- starts the clock on first use, or resumes it (opening a new session) after
// a Hold. Every call is logged to audit_logs.
router.put('/process/:processId/start', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { proc, error } = await getOwnedProcess(conn, req.params.processId, req.user.id);
    if (error) { await conn.rollback(); return res.status(error[0]).json({ error: error[1] }); }
    if (proc.assignment_ended_at) {
      await conn.rollback();
      return res.status(409).json({ error: 'This process has already been completed.' });
    }
    const [[openSession]] = await conn.query(
      'SELECT id FROM job_order_process_sessions WHERE job_order_process_id = ? AND ended_at IS NULL',
      [req.params.processId]
    );
    if (openSession) {
      await conn.rollback();
      return res.status(409).json({ error: 'The timer is already running.' });
    }

    const isFirstStart = !proc.assignment_started_at;
    await conn.query('INSERT INTO job_order_process_sessions (job_order_process_id, started_at) VALUES (?, NOW())', [req.params.processId]);
    if (isFirstStart) {
      await conn.query('UPDATE job_order_processes SET assignment_started_at = NOW() WHERE id = ?', [req.params.processId]);
    }
    await logAudit(conn, { processId: req.params.processId, userId: req.user.id, eventType: 'Updated', fieldName: isFirstStart ? 'assignment_timer_started' : 'assignment_timer_resumed', newValue: new Date().toISOString() });
    await conn.commit();

    const [[row]] = await pool.query('SELECT id, assignment_started_at FROM job_order_processes WHERE id = ?', [req.params.processId]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// "Hold" -- pauses the running clock by closing the currently open session.
router.put('/process/:processId/hold', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { proc, error } = await getOwnedProcess(conn, req.params.processId, req.user.id);
    if (error) { await conn.rollback(); return res.status(error[0]).json({ error: error[1] }); }
    if (proc.assignment_ended_at) {
      await conn.rollback();
      return res.status(409).json({ error: 'This process has already been completed.' });
    }
    const [result] = await conn.query(
      'UPDATE job_order_process_sessions SET ended_at = NOW() WHERE job_order_process_id = ? AND ended_at IS NULL',
      [req.params.processId]
    );
    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(409).json({ error: 'The timer is not currently running.' });
    }
    await logAudit(conn, { processId: req.params.processId, userId: req.user.id, eventType: 'Updated', fieldName: 'assignment_timer_held', newValue: new Date().toISOString() });
    await conn.commit();

    res.json({ id: Number(req.params.processId) });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// "Stop" -- closes any open session and marks the assignment done.
router.put('/process/:processId/finish', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { proc, error } = await getOwnedProcess(conn, req.params.processId, req.user.id);
    if (error) { await conn.rollback(); return res.status(error[0]).json({ error: error[1] }); }
    if (!proc.assignment_started_at) {
      await conn.rollback();
      return res.status(409).json({ error: 'The timer has not been started yet.' });
    }
    if (proc.assignment_ended_at) {
      await conn.rollback();
      return res.status(409).json({ error: 'The timer has already been stopped for this process.' });
    }

    await conn.query('UPDATE job_order_process_sessions SET ended_at = NOW() WHERE job_order_process_id = ? AND ended_at IS NULL', [req.params.processId]);
    await conn.query('UPDATE job_order_processes SET assignment_ended_at = NOW() WHERE id = ?', [req.params.processId]);
    await logAudit(conn, { processId: req.params.processId, userId: req.user.id, eventType: 'Updated', fieldName: 'assignment_timer_completed', newValue: new Date().toISOString() });
    await conn.commit();

    const [[row]] = await pool.query('SELECT id, assignment_started_at, assignment_ended_at FROM job_order_processes WHERE id = ?', [req.params.processId]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
