const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');
const { getJobLocationScope, isJobLocationVisible } = require('../lib/jobLocationVisibility');

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

// A production-department employee gets the personal-worklist view (their own assignments
// only), unless isScheduler below says they are there to hand work out rather than take it.
// Anyone else with access to this page -- a department supervisor, admin -- isn't themselves a
// valid assignee, so they get the scheduling overview: every currently in-process Job Order,
// opened to assign staff per task.
async function isProductionEmployee(employeeId) {
  if (!employeeId) return false;
  const [[row]] = await pool.query(
    `SELECT e.id FROM employees e JOIN departments d ON d.id = e.department_id
     WHERE e.id = ? AND d.name LIKE 'Production%'`,
    [employeeId]
  );
  return !!row;
}

// Who schedules the work rather than doing it. A Signage Planner is filed under a production
// department but assigns jobs instead of running them, so without this they would land on a
// personal worklist that is always empty -- nobody assigns tasks to the person doing the
// assigning. The flag has to carry this on its own because a planner deliberately holds no
// production edit rights (see db/add-signage-planner-role.js); this is the same test
// requireScheduler applies on the Production screen. can_edit here covers the GM/System Admin
// path, who were already getting the scheduling view by not being production employees.
async function isScheduler(userId) {
  const [[u]] = await pool.query('SELECT is_signage_planner FROM users WHERE id = ?', [userId]);
  if (u?.is_signage_planner) return true;
  return userCan(userId, ROUTE, 'can_edit');
}

// Gate for setting planned dates. Mirrors production.js's requireScheduler: a Signage Planner
// schedules without holding can_edit here, since that permission also carries staffing.
async function requireScheduler(req, res, next) {
  try {
    if (await isScheduler(req.user.id)) return next();
    return res.status(403).json({ error: 'You do not have scheduling access.' });
  } catch (err) { return next(err); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// undefined = malformed, which is deliberately distinct from null = the planner cleared it.
function parseDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = String(v).slice(0, 10);
  return DATE_RE.test(d) ? d : undefined;
}

// Whether this user may open this job order's task table at all: their own warehouse's job,
// or one merely carrying a line worked there. Shared by the task table and the planned-date
// write so the two cannot disagree about what is reachable.
async function canOpenJobOrder(userId, jobOrder) {
  const scopeLocationId = await getJobLocationScope(userId);
  if (!scopeLocationId || isJobLocationVisible(jobOrder, scopeLocationId)) return true;
  const [[lineHere]] = await pool.query(
    'SELECT 1 AS ok FROM job_order_processes WHERE job_order_id = ? AND location_id = ? LIMIT 1',
    [jobOrder.id, scopeLocationId]
  );
  return !!lineHere;
}

// Feeds the "Assigned To" picker -- Production-department employees, narrowed to the ones who
// work the scheduler's own warehouse. A SIGNAGE planner staffs SIGNAGE jobs; offering them CNC
// and DPOD staff invites an assignment nobody in that warehouse can act on. Departments are
// matched through the same departments.job_location_id map the job order lists use, so a
// department only contributes staff once it is mapped to a warehouse. Registered ahead of the
// /:jobOrderId param route so "production-employees" isn't swallowed as a jobOrderId value.
router.get('/production-employees', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const scopeLocationId = await getJobLocationScope(req.user.id);
    const [rows] = await pool.query(
      `SELECT e.id, e.first_name, e.last_name, e.position_title, d.name AS department_name
       FROM employees e JOIN departments d ON d.id = e.department_id
       WHERE d.name LIKE 'Production%' AND e.is_active = TRUE${scopeLocationId ? ' AND d.job_location_id = ?' : ''}
       ORDER BY e.first_name, e.last_name`,
      scopeLocationId ? [scopeLocationId] : []
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Landing list: a production employee sees their own personal task worklist (mode: 'tasks');
// a scheduler -- a Signage Planner, or anyone with can_edit here -- and everyone else (a
// department supervisor, admin) sees every in-process Job Order instead (mode: 'jobs'),
// opening one to the Task table to assign staff per process line, matching the real system's
// Scheduled JO screen.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    // A scheduler gets the job list even when their employee record sits in a production
    // department -- see isScheduler above.
    const mine = !(await isScheduler(req.user.id)) && await isProductionEmployee(me?.employee_id);

    // A production department only sees its own warehouse's work. Two different tests, because a
    // job order and its process lines can sit in different warehouses -- tens of thousands do, a
    // SIGN job order routinely carrying an LFP or a Design line:
    //   - a worker's own task list goes by the LINE's location, which is where that task is
    //     actually worked. Filtering it by the job order's would hide an LFP worker's LFP line on
    //     a SIGN job order -- their own assigned work, invisible to them.
    //   - the scheduler's job list takes a job order whose own location matches OR which carries
    //     any line at this warehouse, so no work here is unreachable from the list.
    const scopeLocationId = await getJobLocationScope(req.user.id);
    const taskLocationClause = scopeLocationId ? ' AND COALESCE(jop.location_id, jo.job_location_id) = ?' : '';
    const taskLocationParams = scopeLocationId ? [scopeLocationId] : [];
    const jobLocationClause = scopeLocationId
      ? ' AND (jo.job_location_id = ? OR EXISTS (SELECT 1 FROM job_order_processes pl WHERE pl.job_order_id = jo.id AND pl.location_id = ?))'
      : '';
    const jobLocationParams = scopeLocationId ? [scopeLocationId, scopeLocationId] : [];

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
         WHERE jop.assigned_employee_id = ?${taskLocationClause}
         ORDER BY jop.id DESC`,
        [me.employee_id, ...taskLocationParams]
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
       WHERE jo.production_stage = 'in_process'${jobLocationClause}
       ORDER BY jo.id DESC`,
      jobLocationParams
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
              loc.location_name AS job_location_name, c.name AS customer_name, jo.job_location_id
       FROM job_orders jo
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       WHERE jo.id = ?`,
      [req.params.jobOrderId]
    );
    if (!jo) return res.status(404).json({ error: 'Not found' });
    // Openable if the job order is this user's warehouse, or if it merely carries a line worked
    // there -- a SIGN line on an LFP job order is still SIGNAGE's to staff, and refusing the page
    // would leave it unreachable. 404 otherwise, matching the other JO detail views.
    const scopeLocationId = await getJobLocationScope(req.user.id);
    if (!(await canOpenJobOrder(req.user.id, jo))) return res.status(404).json({ error: 'Not found' });

    const [tasks] = await pool.query(
      `SELECT jop.id, jop.qty, jop.unit, jop.total, jop.process_cost, jop.material_cost,
              jop.assigned_employee_id, jop.assignment_started_at, jop.assignment_ended_at,
              jop.planned_start_date, jop.planned_end_date,
              pr.process_name, pr.minutes_per_unit, loc.location_name, i.display_name AS item_name,
              -- A line carrying no location of its own is worked in its job order's warehouse,
              -- not nowhere -- the same fallback the Production view's figures use.
              COALESCE(jop.location_id, ?) AS effective_location_id,
              COALESCE(jop.total, 0) * COALESCE(pr.minutes_per_unit, 0) AS allotted_minutes,
              CONCAT(ae.first_name, ' ', ae.last_name) AS assigned_employee_name,
              EXISTS(SELECT 1 FROM job_order_process_sessions s WHERE s.job_order_process_id = jop.id AND s.ended_at IS NULL) AS is_running
       FROM job_order_processes jop
       LEFT JOIN processes pr ON pr.id = jop.process_id
       LEFT JOIN locations loc ON loc.id = jop.location_id
       LEFT JOIN inventories i ON i.id = jop.item_id
       LEFT JOIN employees ae ON ae.id = jop.assigned_employee_id
       WHERE jop.job_order_id = ? ORDER BY jop.line_no`,
      [jo.job_location_id, req.params.jobOrderId]
    );

    // can_assign says whether THIS user may staff THIS line. A line worked at another warehouse
    // belongs to that department's scheduler, so it stays visible -- the planner still needs to
    // read the whole job -- but its Assigned To picker is locked.
    //
    // Planned dates are deliberately NOT narrowed the same way. Scheduling is the planner's job
    // for the WHOLE order: a SIGN line that can only start once Design has finished its layout
    // is exactly the dependency they are sequencing, and they cannot plan around a line whose
    // dates they may not set. Staffing stays local because only that warehouse knows who is
    // free; dates are the plan, and the plan spans warehouses. So can_schedule is a property of
    // the user (are they a scheduler at all), not of the line's location.
    const canSchedule = await isScheduler(req.user.id);
    res.json({
      ...jo,
      can_schedule: canSchedule,
      tasks: tasks.map((t) => ({
        ...t,
        is_running: !!t.is_running,
        can_assign: !scopeLocationId || Number(t.effective_location_id) === Number(scopeLocationId),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Assigning (or clearing, when employee_id is falsy) who will run a task/process line.
router.put('/:jobOrderId/tasks/:processId/assign', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    // Assignment is per process line, and a line can sit in a different warehouse from its job
    // order, so it is the LINE's location that decides -- by the job order's, a SIGNAGE planner
    // could staff the LFP or Design line of a SIGN job order. The picker already narrows the
    // choices; this is the same rule held against a raw request. 403 rather than 404 because the
    // line is visible to them on the task table, just not theirs to assign.
    const scopeLocationId = await getJobLocationScope(req.user.id);
    const [[line]] = await pool.query(
      `SELECT COALESCE(jop.location_id, jo.job_location_id) AS effective_location_id
         FROM job_order_processes jop
         JOIN job_orders jo ON jo.id = jop.job_order_id
        WHERE jop.id = ? AND jop.job_order_id = ?`,
      [req.params.processId, req.params.jobOrderId]
    );
    if (!line) return res.status(404).json({ error: 'Not found' });
    if (scopeLocationId && Number(line.effective_location_id) !== Number(scopeLocationId)) {
      return res.status(403).json({ error: 'That process line is worked at another location.' });
    }

    const employeeId = req.body.employee_id || null;
    if (employeeId) {
      const [[emp]] = await pool.query(
        `SELECT e.id FROM employees e JOIN departments d ON d.id = e.department_id
         WHERE e.id = ? AND d.name LIKE 'Production%'${scopeLocationId ? ' AND d.job_location_id = ?' : ''}`,
        scopeLocationId ? [employeeId, scopeLocationId] : [employeeId]
      );
      if (!emp) {
        return res.status(400).json({
          error: scopeLocationId
            ? 'That employee is not in a Production department for this job location.'
            : 'That employee is not in a Production department.',
        });
      }
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

// Planned Start/End for one task (process line). Unlike /assign directly above, this is NOT
// narrowed to the caller's own warehouse -- see the note on can_schedule in the task table
// above. What still applies is that they must be a scheduler, and the job order must be one
// they can open at all; a planner cannot reach into a job with no line of theirs on it.
//
// Either date may be sent on its own; the one not mentioned keeps its stored value, so
// setting Start does not silently clear End. Sending an explicit empty string clears it.
router.put('/:jobOrderId/tasks/:processId/planned-dates', requireAuth, requirePermission(ROUTE, 'can_view'), requireScheduler, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[jo]] = await conn.query('SELECT id, job_location_id, status FROM job_orders WHERE id = ?', [req.params.jobOrderId]);
    if (!jo) return res.status(404).json({ error: 'Not found' });
    if (!(await canOpenJobOrder(req.user.id, jo))) return res.status(404).json({ error: 'Not found' });
    if (jo.status === 'Cancelled') return res.status(409).json({ error: 'This job order is cancelled.' });

    const [[line]] = await conn.query(
      'SELECT id, planned_start_date, planned_end_date FROM job_order_processes WHERE id = ? AND job_order_id = ?',
      [req.params.processId, req.params.jobOrderId]
    );
    if (!line) return res.status(404).json({ error: 'Not found' });

    const asDay = (v) => (v ? String(v).slice(0, 10) : '');
    const start = 'planned_start_date' in req.body ? parseDate(req.body.planned_start_date) : asDay(line.planned_start_date) || null;
    const end = 'planned_end_date' in req.body ? parseDate(req.body.planned_end_date) : asDay(line.planned_end_date) || null;
    if (start === undefined || end === undefined) {
      return res.status(400).json({ error: 'Dates must be in YYYY-MM-DD format.' });
    }
    if (start && end && end < start) {
      return res.status(400).json({ error: 'Planned End cannot be before Planned Start.' });
    }

    await conn.beginTransaction();
    await conn.query(
      'UPDATE job_order_processes SET planned_start_date = ?, planned_end_date = ? WHERE id = ? AND job_order_id = ?',
      [start, end, req.params.processId, req.params.jobOrderId]
    );
    for (const [field, before, after] of [
      ['planned_start_date', asDay(line.planned_start_date), start || ''],
      ['planned_end_date', asDay(line.planned_end_date), end || ''],
    ]) {
      if (before === after) continue;
      await logAudit(conn, {
        processId: req.params.processId, userId: req.user.id, eventType: 'Updated',
        fieldName: field, oldValue: before, newValue: after,
      });
    }
    await conn.commit();
    res.json({ planned_start_date: start, planned_end_date: end });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
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
