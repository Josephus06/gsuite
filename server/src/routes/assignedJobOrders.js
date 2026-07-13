const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/assigned-jo';

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

    const [rows] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.status, jo.sub_status, jo.description,
              jo.planned_start_at, jo.planned_end_at, jo.layout_started_at, jo.layout_ended_at, jo.layout_qty,
              c.name AS customer_name,
              pjt.id AS pms_job_type_id, pjt.code AS pms_job_type_code, pjt.display_name AS pms_job_type_name,
              pjt.minutes_consume,
              EXISTS(SELECT 1 FROM job_order_layout_sessions s WHERE s.job_order_id = jo.id AND s.ended_at IS NULL) AS is_running
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN pms_job_types pjt ON pjt.id = jo.layout_job_type_id
       WHERE jo.artist_id = ? AND jo.sub_status IN ('For Artist', 'For Artist (Revision)')
       ORDER BY jo.id DESC`,
      [me.employee_id]
    );

    res.json(rows.map((r) => ({ ...r, is_running: !!r.is_running })));
  } catch (err) {
    next(err);
  }
});

// Single JO detail for the "run" screen -- includes the full Play/Hold session log so
// the artist can see exactly when they started, held, resumed, and (once done) stopped.
router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    const [[row]] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.status, jo.sub_status, jo.description, jo.artist_id,
              jo.planned_start_at, jo.planned_end_at, jo.layout_started_at, jo.layout_ended_at, jo.layout_qty,
              c.name AS customer_name,
              pjt.id AS pms_job_type_id, pjt.code AS pms_job_type_code, pjt.display_name AS pms_job_type_name,
              pjt.minutes_consume
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN pms_job_types pjt ON pjt.id = jo.layout_job_type_id
       WHERE jo.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!me?.employee_id || row.artist_id !== me.employee_id) {
      return res.status(403).json({ error: 'This Job Order is not assigned to you.' });
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
