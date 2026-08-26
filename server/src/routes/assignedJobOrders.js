const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const {
  jobOrderIncentiveExpression, nstdjoIncentiveExpression, joIncentiveBasis, NSTDJO_INCENTIVE_BASIS,
} = require('../lib/artistIncentive');
const { getJobLocationScope, isJobLocationVisible } = require('../lib/jobLocationVisibility');

const router = express.Router();
const ROUTE = '/assigned-jo';

// The queue used to stop at the two sub-statuses where the artist still has the work in
// hand. It now carries the whole tail of their involvement, because the list groups into
// tabs and an order that vanishes the moment it is sent for approval leaves the artist no
// way to see what became of it -- or that their incentive has been credited.
//
//   'For Artist' / 'For Artist (Revision)'  -> theirs to work on (Not Started, Started/On Hold)
//   'Sales Approval'                        -> sent, waiting on Sales
//   'Approved'                              -> signed off; this is what earns the incentive
const ARTIST_QUEUE_SUB_STATUSES = ['For Artist', 'For Artist (Revision)', 'Sales Approval', 'Approved'];

async function logAudit(conn, { jobOrderId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('JobOrder', ?, ?, ?, ?, ?, ?)`,
    [jobOrderId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Ownership check shared by start/hold/finish -- only the assigned artist can drive
// their own clock.
async function getOwnedJobOrder(conn, jobOrderId, userId) {
  const [[me]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [userId]);
  const [[jo]] = await conn.query('SELECT artist_id, sub_status, layout_started_at, layout_ended_at FROM job_orders WHERE id = ?', [jobOrderId]);
  if (!jo) return { error: [404, 'Not found'] };
  if (!me?.employee_id || jo.artist_id !== me.employee_id) return { error: [403, 'This Job Order is not assigned to you.'] };
  return { jo };
}

// Artist's "Assigned JO" module -- always scoped to the logged-in user's own employee
// record as the artist, regardless of who's logged in (admin included), since this
// mirrors a personal worklist rather than an admin-wide view. This is an index only --
// the artist opens a specific JO (GET /:id) to actually run its timer, rather than
// driving Play/Hold/Stop from this list.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    if (!me?.employee_id) return res.json([]);

    // An artist filed under a production department only sees that warehouse's layout work. Two
    // fragments because the worklist unions job_orders (jo) with non_standard_job_orders (n), and
    // each carries its own job_location_id.
    const scopeLocationId = await getJobLocationScope(req.user.id);
    const joLocationClause = scopeLocationId ? ' AND jo.job_location_id = ?' : '';
    const nstdjoLocationClause = scopeLocationId ? ' AND n.job_location_id = ?' : '';
    const locationParams = scopeLocationId ? [scopeLocationId] : [];

    const [rows] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.status, jo.sub_status, jo.description,
              jo.planned_start_at, jo.planned_end_at, jo.layout_started_at, jo.layout_ended_at, jo.layout_qty,
              c.name AS customer_name,
              pjt.id AS pms_job_type_id, pjt.code AS pms_job_type_code, pjt.display_name AS pms_job_type_name,
              pjt.minutes_consume,
              -- Same expressions the Artist Incentive report uses, so the artist's worklist
              -- and their report cannot quote different figures for the same job.
              ${jobOrderIncentiveExpression('jo')} AS incentive_amount,
              ${joIncentiveBasis('jo')} AS incentive_basis,
              -- The job order's own rep if it carries one, otherwise the sales order's --
              -- same fallback the run screen uses, so the list and the job agree about who
              -- to go to with a question.
              COALESCE(CONCAT(jsr.first_name, ' ', jsr.last_name),
                       CONCAT(ssr.first_name, ' ', ssr.last_name)) AS sales_rep_name,
              EXISTS(SELECT 1 FROM job_order_layout_sessions s WHERE s.job_order_id = jo.id AND s.ended_at IS NULL) AS is_running
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees jsr ON jsr.id = jo.sales_rep_id
       LEFT JOIN employees ssr ON ssr.id = so.sales_rep_id
       LEFT JOIN pms_job_types pjt ON pjt.id = jo.layout_job_type_id
       WHERE jo.artist_id = ? AND jo.sub_status IN (?)${joLocationClause}
       ORDER BY jo.id DESC`,
      [me.employee_id, ARTIST_QUEUE_SUB_STATUSES, ...locationParams]
    );

    // Non-Standard Job Orders assigned to the same artist appear in the same worklist --
    // they are layout work like any other, just raised outside the Estimate/SO flow.
    // Tagged with `kind` so the client knows which set of timer endpoints to drive.
    const [nstdjoRows] = await pool.query(
      `SELECT n.id, n.nstdjo_no AS job_order_no, n.status, n.sub_status, n.description,
              n.planned_start_at, n.planned_end_at, n.layout_started_at, n.layout_ended_at, n.layout_qty,
              c.name AS customer_name,
              pjt.id AS pms_job_type_id, pjt.code AS pms_job_type_code, pjt.display_name AS pms_job_type_name,
              pjt.minutes_consume,
              ${nstdjoIncentiveExpression('n')} AS incentive_amount,
              '${NSTDJO_INCENTIVE_BASIS}' AS incentive_basis,
              CONCAT(nsr.first_name, ' ', nsr.last_name) AS sales_rep_name,
              EXISTS(SELECT 1 FROM non_standard_job_order_layout_sessions s
                      WHERE s.non_standard_job_order_id = n.id AND s.ended_at IS NULL) AS is_running
       FROM non_standard_job_orders n
       LEFT JOIN customers c ON c.id = n.customer_id
       LEFT JOIN employees nsr ON nsr.id = n.sales_rep_id
       LEFT JOIN pms_job_types pjt ON pjt.id = n.layout_job_type_id
       WHERE n.artist_employee_id = ?
         AND n.sub_status IN (?)${nstdjoLocationClause}
       ORDER BY n.id DESC`,
      [me.employee_id, ARTIST_QUEUE_SUB_STATUSES, ...locationParams]
    );

    res.json([
      ...rows.map((r) => ({ ...r, kind: 'JO', is_running: !!r.is_running })),
      ...nstdjoRows.map((r) => ({ ...r, kind: 'NSTDJO', is_running: !!r.is_running })),
    ]);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------
// Non-Standard Job Orders. A parallel set of endpoints under /nstdjo rather than a
// discriminator on the existing ones, so the Job Order paths above are untouched. The
// stopwatch semantics are identical: each Play opens a session row, Hold closes it, and
// Actual Time Consumed is the sum of closed spans, so held time never counts.
// Registered before '/:id' so the literal segment is not swallowed by that parameter.
// ---------------------------------------------------------------------------------
async function logNstdjoAudit(conn, { id, userId, fieldName, newValue }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, new_value, set_by_user_id)
     VALUES ('NonStandardJobOrder', ?, 'Updated', ?, ?, ?)`,
    [id, fieldName, newValue, userId]
  );
}

// Only the assigned artist drives their own clock.
async function getOwnedNstdjo(conn, id, userId) {
  const [[me]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [userId]);
  const [[row]] = await conn.query(
    'SELECT artist_employee_id, sub_status, layout_started_at, layout_ended_at FROM non_standard_job_orders WHERE id = ?',
    [id]
  );
  if (!row) return { error: [404, 'Not found'] };
  if (!me?.employee_id || row.artist_employee_id !== me.employee_id) {
    return { error: [403, 'This Non-Standard Job Order is not assigned to you.'] };
  }
  return { row };
}

// Whatever this artist currently has the clock running on, if anything. Drives the floating
// timer that follows them around the rest of the system, so they can Hold or finish a job
// without navigating back to Assigned JO.
//
// Returns the elapsed time as two numbers rather than a formatted string: consumed_seconds
// for the spans already closed, and started_at for the one still open. The client ticks the
// live part locally, so this does not have to be polled every second to look alive.
//
// Registered before '/:id' and '/nstdjo/:id' so those parameter routes cannot swallow it.
router.get('/running', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    if (!me?.employee_id) return res.json({ running: null });

    const [[jo]] = await pool.query(
      `SELECT 'JO' AS kind, jo.id, jo.job_order_no, jo.description, jo.layout_qty,
              pjt.minutes_consume, s.started_at,
              (SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, c.started_at, c.ended_at)), 0)
                 FROM job_order_layout_sessions c
                WHERE c.job_order_id = jo.id AND c.ended_at IS NOT NULL) AS consumed_seconds
         FROM job_order_layout_sessions s
         JOIN job_orders jo ON jo.id = s.job_order_id
         LEFT JOIN pms_job_types pjt ON pjt.id = jo.layout_job_type_id
        WHERE s.ended_at IS NULL AND jo.artist_id = ? AND jo.layout_ended_at IS NULL
        ORDER BY s.started_at DESC LIMIT 1`,
      [me.employee_id],
    );

    const [[nstdjo]] = await pool.query(
      `SELECT 'NSTDJO' AS kind, n.id, n.nstdjo_no AS job_order_no, n.description, n.layout_qty,
              pjt.minutes_consume, s.started_at,
              (SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, c.started_at, c.ended_at)), 0)
                 FROM non_standard_job_order_layout_sessions c
                WHERE c.non_standard_job_order_id = n.id AND c.ended_at IS NOT NULL) AS consumed_seconds
         FROM non_standard_job_order_layout_sessions s
         JOIN non_standard_job_orders n ON n.id = s.non_standard_job_order_id
         LEFT JOIN pms_job_types pjt ON pjt.id = n.layout_job_type_id
        WHERE s.ended_at IS NULL AND n.artist_employee_id = ? AND n.layout_ended_at IS NULL
        ORDER BY s.started_at DESC LIMIT 1`,
      [me.employee_id],
    );

    // Nothing stops both tables holding an open session -- the two modules run independent
    // timers -- so the most recently started one wins rather than an arbitrary preference
    // for Job Orders.
    const candidates = [jo, nstdjo].filter(Boolean);
    if (!candidates.length) return res.json({ running: null });
    candidates.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
    res.json({ running: candidates[0] });
  } catch (err) {
    next(err);
  }
});

router.get('/nstdjo/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    const [[row]] = await pool.query(
      `SELECT n.id, n.nstdjo_no AS job_order_no, n.status, n.sub_status, n.description, n.quantity,
              n.planned_start_at, n.planned_end_at, n.layout_started_at, n.layout_ended_at, n.layout_qty,
              n.artist_employee_id, c.name AS customer_name, n.job_type,
              n.sales_revision_count, n.last_revision_at, n.last_revision_note,
              CONCAT(nsr.first_name, ' ', nsr.last_name) AS sales_rep_name,
              pjt.id AS pms_job_type_id, pjt.code AS pms_job_type_code, pjt.display_name AS pms_job_type_name,
              pjt.minutes_consume
         FROM non_standard_job_orders n
         LEFT JOIN customers c ON c.id = n.customer_id
         LEFT JOIN employees nsr ON nsr.id = n.sales_rep_id
         LEFT JOIN pms_job_types pjt ON pjt.id = n.layout_job_type_id
        WHERE n.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!me?.employee_id || row.artist_employee_id !== me.employee_id) {
      return res.status(403).json({ error: 'This Non-Standard Job Order is not assigned to you.' });
    }
    const [sessions] = await pool.query(
      'SELECT id, started_at, ended_at FROM non_standard_job_order_layout_sessions WHERE non_standard_job_order_id = ? ORDER BY id',
      [req.params.id]
    );
    res.json({ ...row, kind: 'NSTDJO', sessions, is_running: sessions.some((s) => !s.ended_at) });
  } catch (err) { next(err); }
});

router.put('/nstdjo/:id/start-layout', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { row, error } = await getOwnedNstdjo(conn, req.params.id, req.user.id);
    if (error) { await conn.rollback(); return res.status(error[0]).json({ error: error[1] }); }
    if (row.sub_status !== 'For Artist' && row.sub_status !== 'For Artist (Revision)') {
      await conn.rollback();
      return res.status(409).json({ error: 'This Non-Standard Job Order is not ready for layouting.' });
    }
    if (row.layout_ended_at) {
      await conn.rollback();
      return res.status(409).json({ error: 'This Non-Standard Job Order has already been completed.' });
    }
    const [[open]] = await conn.query(
      'SELECT id FROM non_standard_job_order_layout_sessions WHERE non_standard_job_order_id = ? AND ended_at IS NULL',
      [req.params.id]
    );
    if (open) { await conn.rollback(); return res.status(409).json({ error: 'The layout timer is already running.' }); }

    const isFirstStart = !row.layout_started_at;
    await conn.query(
      'INSERT INTO non_standard_job_order_layout_sessions (non_standard_job_order_id, started_at) VALUES (?, NOW())',
      [req.params.id]
    );
    if (isFirstStart) {
      await conn.query('UPDATE non_standard_job_orders SET layout_started_at = NOW(), updated_at = NOW() WHERE id = ?', [req.params.id]);
    }
    await logNstdjoAudit(conn, {
      id: req.params.id, userId: req.user.id,
      fieldName: isFirstStart ? 'layout_timer_started' : 'layout_timer_resumed', newValue: new Date().toISOString(),
    });
    await conn.commit();
    const [[out]] = await pool.query('SELECT id, layout_started_at FROM non_standard_job_orders WHERE id = ?', [req.params.id]);
    res.json(out);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

router.put('/nstdjo/:id/hold-layout', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { row, error } = await getOwnedNstdjo(conn, req.params.id, req.user.id);
    if (error) { await conn.rollback(); return res.status(error[0]).json({ error: error[1] }); }
    if (row.layout_ended_at) {
      await conn.rollback();
      return res.status(409).json({ error: 'This Non-Standard Job Order has already been completed.' });
    }
    const [result] = await conn.query(
      'UPDATE non_standard_job_order_layout_sessions SET ended_at = NOW() WHERE non_standard_job_order_id = ? AND ended_at IS NULL',
      [req.params.id]
    );
    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(409).json({ error: 'The layout timer is not currently running.' });
    }
    await logNstdjoAudit(conn, { id: req.params.id, userId: req.user.id, fieldName: 'layout_timer_held', newValue: new Date().toISOString() });
    await conn.commit();
    res.json({ id: Number(req.params.id) });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

router.put('/nstdjo/:id/finish-layout', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { row, error } = await getOwnedNstdjo(conn, req.params.id, req.user.id);
    if (error) { await conn.rollback(); return res.status(error[0]).json({ error: error[1] }); }
    if (!row.layout_started_at) {
      await conn.rollback();
      return res.status(409).json({ error: 'The layout timer has not been started yet.' });
    }
    if (row.layout_ended_at) {
      await conn.rollback();
      return res.status(409).json({ error: 'The layout timer has already been stopped for this Non-Standard Job Order.' });
    }
    await conn.query('UPDATE non_standard_job_order_layout_sessions SET ended_at = NOW() WHERE non_standard_job_order_id = ? AND ended_at IS NULL', [req.params.id]);
    await conn.query('UPDATE non_standard_job_orders SET layout_ended_at = NOW(), updated_at = NOW() WHERE id = ?', [req.params.id]);
    await logNstdjoAudit(conn, { id: req.params.id, userId: req.user.id, fieldName: 'layout_timer_completed', newValue: new Date().toISOString() });
    await conn.commit();
    const [[out]] = await pool.query('SELECT id, layout_started_at, layout_ended_at FROM non_standard_job_orders WHERE id = ?', [req.params.id]);
    res.json(out);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// Single JO detail for the "run" screen -- includes the full Play/Hold session log so
// the artist can see exactly when they started, held, resumed, and (once done) stopped.
router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    const [[row]] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.status, jo.sub_status, jo.description, jo.artist_id,
              jo.job_location_id,
              jo.planned_start_at, jo.planned_end_at, jo.layout_started_at, jo.layout_ended_at, jo.layout_qty,
              c.name AS customer_name,
              COALESCE(CONCAT(jsr.first_name, ' ', jsr.last_name),
                       CONCAT(ssr.first_name, ' ', ssr.last_name)) AS sales_rep_name,
              pjt.id AS pms_job_type_id, pjt.code AS pms_job_type_code, pjt.display_name AS pms_job_type_name,
              pjt.minutes_consume
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees jsr ON jsr.id = jo.sales_rep_id
       LEFT JOIN employees ssr ON ssr.id = so.sales_rep_id
       LEFT JOIN pms_job_types pjt ON pjt.id = jo.layout_job_type_id
       WHERE jo.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!me?.employee_id || row.artist_id !== me.employee_id) {
      return res.status(403).json({ error: 'This Job Order is not assigned to you.' });
    }
    // Out of this user's department -- 404 rather than 403, matching the JO detail views: an
    // out-of-department job order should read as one that isn't there.
    if (!isJobLocationVisible(row, await getJobLocationScope(req.user.id))) {
      return res.status(404).json({ error: 'Not found' });
    }

    const [sessions] = await pool.query(
      'SELECT id, started_at, ended_at FROM job_order_layout_sessions WHERE job_order_id = ? ORDER BY started_at ASC',
      [req.params.id]
    );

    res.json({ ...row, sessions });
  } catch (err) {
    next(err);
  }
});

// "Play" -- starts the clock on first use, or resumes it (opening a new session) after
// a Hold. Every call is logged to audit_logs.
router.put('/:id/start-layout', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { jo, error } = await getOwnedJobOrder(conn, req.params.id, req.user.id);
    if (error) { await conn.rollback(); return res.status(error[0]).json({ error: error[1] }); }
    if (jo.sub_status !== 'For Artist' && jo.sub_status !== 'For Artist (Revision)') {
      await conn.rollback();
      return res.status(409).json({ error: 'This Job Order is not ready for layouting.' });
    }
    if (jo.layout_ended_at) {
      await conn.rollback();
      return res.status(409).json({ error: 'This Job Order has already been completed.' });
    }
    const [[openSession]] = await conn.query(
      'SELECT id FROM job_order_layout_sessions WHERE job_order_id = ? AND ended_at IS NULL',
      [req.params.id]
    );
    if (openSession) {
      await conn.rollback();
      return res.status(409).json({ error: 'The layout timer is already running.' });
    }

    const isFirstStart = !jo.layout_started_at;
    await conn.query('INSERT INTO job_order_layout_sessions (job_order_id, started_at) VALUES (?, NOW())', [req.params.id]);
    if (isFirstStart) {
      await conn.query('UPDATE job_orders SET layout_started_at = NOW(), updated_at = NOW() WHERE id = ?', [req.params.id]);
    }
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: isFirstStart ? 'layout_timer_started' : 'layout_timer_resumed', newValue: new Date().toISOString() });
    await conn.commit();

    const [[row]] = await pool.query('SELECT id, layout_started_at FROM job_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// "Hold" -- pauses the running clock by closing the currently open session. Time spent
// held doesn't count toward Actual Time Consumed.
router.put('/:id/hold-layout', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { jo, error } = await getOwnedJobOrder(conn, req.params.id, req.user.id);
    if (error) { await conn.rollback(); return res.status(error[0]).json({ error: error[1] }); }
    if (jo.layout_ended_at) {
      await conn.rollback();
      return res.status(409).json({ error: 'This Job Order has already been completed.' });
    }
    const [result] = await conn.query(
      'UPDATE job_order_layout_sessions SET ended_at = NOW() WHERE job_order_id = ? AND ended_at IS NULL',
      [req.params.id]
    );
    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(409).json({ error: 'The layout timer is not currently running.' });
    }
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'layout_timer_held', newValue: new Date().toISOString() });
    await conn.commit();

    res.json({ id: Number(req.params.id) });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// "Stop" -- closes any open session and marks Actual End, completing the task.
router.put('/:id/finish-layout', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { jo, error } = await getOwnedJobOrder(conn, req.params.id, req.user.id);
    if (error) { await conn.rollback(); return res.status(error[0]).json({ error: error[1] }); }
    if (!jo.layout_started_at) {
      await conn.rollback();
      return res.status(409).json({ error: 'The layout timer has not been started yet.' });
    }
    if (jo.layout_ended_at) {
      await conn.rollback();
      return res.status(409).json({ error: 'The layout timer has already been stopped for this Job Order.' });
    }

    await conn.query('UPDATE job_order_layout_sessions SET ended_at = NOW() WHERE job_order_id = ? AND ended_at IS NULL', [req.params.id]);
    await conn.query('UPDATE job_orders SET layout_ended_at = NOW(), updated_at = NOW() WHERE id = ?', [req.params.id]);
    await logAudit(conn, { jobOrderId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'layout_timer_completed', newValue: new Date().toISOString() });
    await conn.commit();

    const [[row]] = await pool.query('SELECT id, layout_started_at, layout_ended_at FROM job_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
