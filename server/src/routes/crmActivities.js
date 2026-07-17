const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const RELATED_TYPES = ['Lead', 'Customer', 'Estimate'];
const ACTIVITY_TYPES = ['call', 'email', 'meeting', 'note', 'task'];

// crm_activities has no `pages` row of its own -- it's always accessed as a sub-
// resource of a Lead/Customer/Estimate (the CRM pipeline's own unit, since
// server/src/routes/crmPipeline.js replaced the old manually-tracked Opportunity), so
// it reuses whichever of THOSE the caller is already permitted to view/edit (same
// `permRoute`-reuse pattern Item Fulfillment/Quality Inspection use, see
// client/src/components/Layout.jsx:31-32). requireAuth alone is enough here since the
// page-level guard already happened on the parent page.

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { related_type: relatedType, related_id: relatedId } = req.query;
    if (!RELATED_TYPES.includes(relatedType) || !relatedId) {
      return res.status(400).json({ error: 'related_type and related_id are required.' });
    }
    const [rows] = await pool.query(
      `SELECT a.*, u1.display_name AS assigned_to_name, u2.display_name AS created_by_name
       FROM crm_activities a
       LEFT JOIN users u1 ON u1.id = a.assigned_to_user_id
       LEFT JOIN users u2 ON u2.id = a.created_by_user_id
       WHERE a.related_type = ? AND a.related_id = ?
       ORDER BY a.created_at DESC`,
      [relatedType, relatedId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Powers the "My Tasks" dashboard widget: open (not-yet-done) tasks assigned to the
// logged-in user, across every Lead/Customer/Estimate, soonest due date first.
router.get('/my-tasks', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.* FROM crm_activities a
       WHERE a.activity_type = 'task' AND a.is_done = FALSE AND a.assigned_to_user_id = ?
       ORDER BY (a.due_date IS NULL), a.due_date ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const {
      related_type: relatedType, related_id: relatedId, activity_type: activityType,
      subject, description, due_date: dueDate, assigned_to_user_id: assignedToUserId,
    } = req.body;
    if (!RELATED_TYPES.includes(relatedType) || !relatedId) {
      return res.status(400).json({ error: 'related_type and related_id are required.' });
    }
    if (!ACTIVITY_TYPES.includes(activityType)) return res.status(400).json({ error: 'Invalid activity type.' });
    if (!subject) return res.status(400).json({ error: 'Subject is required.' });

    const [result] = await pool.query(
      `INSERT INTO crm_activities
         (related_type, related_id, activity_type, subject, description, due_date, assigned_to_user_id, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [relatedType, relatedId, activityType, subject, description || null, dueDate || null,
        assignedToUserId || req.user.id, req.user.id]
    );
    const [[row]] = await pool.query('SELECT * FROM crm_activities WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

// Always expects the full set of editable fields (frontend spreads the existing
// activity and only changes what it's actually editing, e.g. just `is_done` when
// checking off a task) -- avoids ambiguity between "field omitted" and "field cleared"
// that a COALESCE-based partial update would have.
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const { subject, description, due_date: dueDate, is_done: isDone, assigned_to_user_id: assignedToUserId } = req.body;
    if (!subject) return res.status(400).json({ error: 'Subject is required.' });

    const [[existing]] = await pool.query('SELECT is_done, completed_at FROM crm_activities WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    // Only stamp completed_at on the transition into done, and clear it on the
    // transition back out -- re-saving an already-done activity (e.g. editing its
    // subject) shouldn't bump the completion timestamp to "now".
    let completedAt = existing.completed_at;
    if (!!isDone !== !!existing.is_done) completedAt = isDone ? new Date() : null;

    await pool.query(
      `UPDATE crm_activities SET
         subject = ?, description = ?, due_date = ?,
         is_done = ?, completed_at = ?, assigned_to_user_id = ?, updated_at = NOW()
       WHERE id = ?`,
      [subject, description || null, dueDate || null, !!isDone, completedAt, assignedToUserId || null, req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM crm_activities WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM crm_activities WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
