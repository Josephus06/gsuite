const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { ticketVisibilityClause, canManageTicket, isGeneralManager } = require('../lib/ticketVisibility');

const router = express.Router();
const ROUTE = '/tickets';
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

// Every authenticated user needs to be able to list departments to route a ticket or
// (if they're a head) to know which one they manage -- unlike /lookups/departments,
// which is gated behind the Lookups page permission that most non-admin accounts don't
// have. Placed before /:id so Express doesn't treat "meta" as a ticket id.
router.get('/meta/departments', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, name, head_user_id FROM departments WHERE is_active = TRUE ORDER BY name');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Same reasoning as /meta/departments -- a department head assigning a ticket needs the
// list of staff to pick from, but most heads don't have the Users & Permissions page
// permission that GET /users requires. Minimal, non-sensitive fields only. A supervisor
// can only assign within their own department, so this is always scoped to one --
// department_id is required, not an optional filter.
router.get('/meta/assignable-users', requireAuth, async (req, res, next) => {
  try {
    const { department_id: departmentId } = req.query;
    if (!departmentId) return res.status(400).json({ error: 'department_id is required.' });
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.display_name FROM users u
       JOIN employees e ON e.id = u.employee_id
       WHERE u.is_active = TRUE AND e.department_id = ?
       ORDER BY u.display_name`,
      [departmentId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Shared by list + detail: approver_names (who's tagged, for display), is_my_approval
// (does the *viewer* need to act), pending derived client-side from
// approver_names && !approved_at. GROUP_CONCAT/EXISTS subqueries instead of a JOIN so
// a ticket with multiple tagged approvers still comes back as one row, not fanned out.
// is_gm tells the client whether to offer the "Forward to GM"/GM-approve controls at
// all, independent of whether THIS ticket has been forwarded yet.
const APPROVAL_SELECT = `
  ab.display_name AS approved_by_name,
  fb.display_name AS forwarded_by_name,
  gb.display_name AS gm_approved_by_name,
  (SELECT GROUP_CONCAT(u.display_name SEPARATOR ', ') FROM ticket_approvers ta JOIN users u ON u.id = ta.user_id WHERE ta.ticket_id = t.id) AS approver_names,
  EXISTS(SELECT 1 FROM ticket_approvers ta WHERE ta.ticket_id = t.id AND ta.user_id = ?) AS is_my_approval,
  EXISTS(SELECT 1 FROM general_managers gm WHERE gm.user_id = ?) AS is_gm
`;

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { status, department_id: departmentId } = req.query;
    const { sql: visSql, params: visParams } = await ticketVisibilityClause(req.user.id);
    const where = [visSql];
    const params = [...visParams];
    if (status && STATUSES.includes(status)) { where.push('t.status = ?'); params.push(status); }
    if (departmentId) { where.push('t.department_id = ?'); params.push(departmentId); }

    const [rows] = await pool.query(
      `SELECT t.*, d.name AS department_name, cu.display_name AS created_by_name, au.display_name AS assigned_to_name,
              ${APPROVAL_SELECT}
       FROM tickets t
       JOIN departments d ON d.id = t.department_id
       LEFT JOIN users cu ON cu.id = t.created_by_user_id
       LEFT JOIN users au ON au.id = t.assigned_to_user_id
       LEFT JOIN users ab ON ab.id = t.approved_by_user_id
       LEFT JOIN users fb ON fb.id = t.forwarded_by_user_id
       LEFT JOIN users gb ON gb.id = t.gm_approved_by_user_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.id DESC`,
      [req.user.id, req.user.id, ...params]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { sql: visSql, params: visParams } = await ticketVisibilityClause(req.user.id);
    const [[ticket]] = await pool.query(
      `SELECT t.*, d.name AS department_name, cu.display_name AS created_by_name, au.display_name AS assigned_to_name,
              ${APPROVAL_SELECT}
       FROM tickets t
       JOIN departments d ON d.id = t.department_id
       LEFT JOIN users cu ON cu.id = t.created_by_user_id
       LEFT JOIN users au ON au.id = t.assigned_to_user_id
       LEFT JOIN users ab ON ab.id = t.approved_by_user_id
       LEFT JOIN users fb ON fb.id = t.forwarded_by_user_id
       LEFT JOIN users gb ON gb.id = t.gm_approved_by_user_id
       WHERE t.id = ? AND ${visSql}`,
      [req.user.id, req.user.id, req.params.id, ...visParams]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    const [messages] = await pool.query(
      `SELECT m.*, u.display_name AS sender_name FROM ticket_messages m
       LEFT JOIN users u ON u.id = m.sender_user_id
       WHERE m.ticket_id = ? ORDER BY m.created_at ASC`,
      [req.params.id]
    );
    res.json({ ...ticket, messages });
  } catch (err) {
    next(err);
  }
});

// Created by the chat widget once the department + issue have both been collected --
// see server/src/lib/chatbotIntents.js's isTicketTrigger for the flow that leads here.
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { department_id: departmentId, description } = req.body;
    if (!departmentId) return res.status(400).json({ error: 'Select a department.' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'Describe the issue.' });

    const [[dept]] = await pool.query('SELECT id FROM departments WHERE id = ? AND is_active = TRUE', [departmentId]);
    if (!dept) return res.status(400).json({ error: 'Invalid department.' });

    const desc = description.trim();
    const subject = desc.length > 60 ? `${desc.slice(0, 57)}...` : desc;

    // If the creator's own department has one or more rows in
    // department_ticket_approvers (e.g. Sales), those people must sign off before the
    // destination department can act on this ticket -- see the schema.sql comment.
    // Snapshotted into ticket_approvers here rather than re-derived later, so a
    // subsequent change to who approves for that department doesn't retroactively
    // change who's responsible for a ticket already in flight.
    const [creatorDeptApprovers] = await pool.query(
      `SELECT dta.user_id FROM users u
       JOIN employees e ON e.id = u.employee_id
       JOIN departments d ON d.id = e.department_id
       JOIN department_ticket_approvers dta ON dta.department_id = d.id
       WHERE u.id = ?`,
      [req.user.id]
    );

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO tickets (ticket_no, department_id, subject, description, status, created_by_user_id)
         VALUES ('', ?, ?, ?, 'open', ?)`,
        [departmentId, subject, desc, req.user.id]
      );
      const ticketId = result.insertId;
      const ticketNo = `TICKET-${ticketId}`;
      await conn.query('UPDATE tickets SET ticket_no = ? WHERE id = ?', [ticketNo, ticketId]);
      await conn.query(
        'INSERT INTO ticket_messages (ticket_id, sender_user_id, message) VALUES (?, ?, ?)',
        [ticketId, req.user.id, desc]
      );
      for (const { user_id: approverUserId } of creatorDeptApprovers) {
        await conn.query('INSERT INTO ticket_approvers (ticket_id, user_id) VALUES (?, ?)', [ticketId, approverUserId]);
        await conn.query(
          `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
           VALUES (?, 'ticket_pending_approval', ?, ?, 'Ticket', ?)`,
          [approverUserId, `${ticketNo} needs your approval`, subject, ticketId]
        );
      }
      await conn.commit();
      const [[row]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [ticketId]);
      res.status(201).json(row);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    next(err);
  }
});

router.post('/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required.' });

    const { sql: visSql, params: visParams } = await ticketVisibilityClause(req.user.id);
    const [[ticket]] = await pool.query(`SELECT id FROM tickets t WHERE t.id = ? AND ${visSql}`, [req.params.id, ...visParams]);
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    const [result] = await pool.query(
      'INSERT INTO ticket_messages (ticket_id, sender_user_id, message) VALUES (?, ?, ?)',
      [req.params.id, req.user.id, message.trim()]
    );
    const [[row]] = await pool.query(
      `SELECT m.*, u.display_name AS sender_name FROM ticket_messages m
       LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.id = ?`,
      [result.insertId]
    );
    await pool.query('UPDATE tickets SET updated_at = NOW() WHERE id = ?', [req.params.id]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.put('/:id/assign', requireAuth, async (req, res, next) => {
  try {
    const { assigned_to_user_id: assignedToUserId } = req.body;
    const [[ticket]] = await pool.query(
      'SELECT department_id, approved_at, forwarded_to_gm_at, gm_approved_at FROM tickets WHERE id = ?',
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    if (!(await canManageTicket(req.user.id, ticket.department_id))) {
      return res.status(403).json({ error: 'Only this ticket\'s department head can assign it.' });
    }
    const [[{ count: approverCount }]] = await pool.query(
      'SELECT COUNT(*) AS count FROM ticket_approvers WHERE ticket_id = ?', [req.params.id]
    );
    if (approverCount > 0 && !ticket.approved_at) {
      return res.status(409).json({ error: 'This ticket is pending approval and cannot be assigned yet.' });
    }
    if (ticket.forwarded_to_gm_at && !ticket.gm_approved_at) {
      return res.status(409).json({ error: 'This ticket was forwarded to the General Manager and cannot be assigned until approved.' });
    }
    await pool.query(
      "UPDATE tickets SET assigned_to_user_id = ?, assigned_by_user_id = ?, assigned_at = CASE WHEN ? IS NOT NULL THEN NOW() ELSE NULL END, status = IF(status = 'open', 'in_progress', status), updated_at = NOW() WHERE id = ?",
      [assignedToUserId || null, req.user.id, assignedToUserId || null, req.params.id]
    );

    if (assignedToUserId) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, 'ticket_assigned', ?, ?, 'Ticket', ?)`,
        [assignedToUserId, `${ticket.ticket_no} assigned to you`, `You have been assigned ticket ${ticket.ticket_no}.`, req.params.id]
      );
    }

    const [[row]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Any ONE of the tagged approvers (ticket_approvers, snapshotted at creation from the
// creator's department -- see POST /) clears this gate for everyone; it's not
// unanimous. Nothing else changes here; assignment/status flow resumes normally once
// approved_at is set.
router.put('/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const [[ticket]] = await pool.query(
      'SELECT approved_at, ticket_no, department_id, created_by_user_id FROM tickets WHERE id = ?',
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    if (ticket.approved_at) return res.status(409).json({ error: 'This ticket has already been approved.' });

    const [[isApprover]] = await pool.query(
      'SELECT 1 AS x FROM ticket_approvers WHERE ticket_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!isApprover) return res.status(403).json({ error: 'Only this ticket\'s designated approver(s) can approve it.' });

    await pool.query(
      'UPDATE tickets SET approved_by_user_id = ?, approved_at = NOW(), updated_at = NOW() WHERE id = ?',
      [req.user.id, req.params.id]
    );

    // Let the destination department's head know it's actually actionable now --
    // before this they could see it but not assign it.
    const [[dept]] = await pool.query('SELECT head_user_id FROM departments WHERE id = ?', [ticket.department_id]);
    if (dept?.head_user_id) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, 'ticket_ready', ?, ?, 'Ticket', ?)`,
        [dept.head_user_id, `${ticket.ticket_no} is approved and ready to work on`, 'Approval cleared -- this ticket can now be assigned.', req.params.id]
      );
    }

    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
       VALUES (?, 'ticket_approved', ?, ?, 'Ticket', ?)`,
      [ticket.created_by_user_id, `${ticket.ticket_no} has been approved`, `Your ticket ${ticket.ticket_no} has been approved.`, req.params.id]
    );

    const [[row]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Second, independent escalation gate on top of the one above -- the department
// head/supervisor (canManageTicket) can forward a not-yet-assigned ticket to the
// General Manager for extra sign-off. Deliberately restricted to before assignment:
// this is about deciding whether to take the ticket on at all, not something to layer
// on afterward.
router.put('/:id/forward-to-gm', requireAuth, async (req, res, next) => {
  try {
    const [[ticket]] = await pool.query(
      'SELECT department_id, assigned_to_user_id, forwarded_to_gm_at, ticket_no, subject FROM tickets WHERE id = ?',
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    if (!(await canManageTicket(req.user.id, ticket.department_id))) {
      return res.status(403).json({ error: 'Only this ticket\'s department head can forward it.' });
    }
    if (ticket.assigned_to_user_id) return res.status(409).json({ error: 'This ticket has already been assigned.' });
    if (ticket.forwarded_to_gm_at) return res.status(409).json({ error: 'This ticket has already been forwarded.' });

    const [gms] = await pool.query('SELECT user_id FROM general_managers');
    if (!gms.length) return res.status(409).json({ error: 'No General Manager is configured yet.' });

    await pool.query(
      'UPDATE tickets SET forwarded_to_gm_at = NOW(), forwarded_by_user_id = ?, updated_at = NOW() WHERE id = ?',
      [req.user.id, req.params.id]
    );
    for (const { user_id: gmUserId } of gms) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, 'gm_approval_needed', ?, ?, 'Ticket', ?)`,
        [gmUserId, `${ticket.ticket_no} needs GM approval`, ticket.subject, req.params.id]
      );
    }

    const [[row]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Any ONE tagged General Manager (general_managers -- company-wide, not per-ticket)
// clears this gate. Nothing else changes here; PUT /:id/assign resumes working once
// gm_approved_at is set.
router.put('/:id/gm-approve', requireAuth, async (req, res, next) => {
  try {
    const [[ticket]] = await pool.query(
      'SELECT forwarded_to_gm_at, gm_approved_at, forwarded_by_user_id, ticket_no FROM tickets WHERE id = ?',
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    if (!ticket.forwarded_to_gm_at) return res.status(409).json({ error: 'This ticket has not been forwarded to the General Manager.' });
    if (ticket.gm_approved_at) return res.status(409).json({ error: 'This ticket has already been GM-approved.' });
    if (!(await isGeneralManager(req.user.id))) {
      return res.status(403).json({ error: 'Only a General Manager can approve this.' });
    }

    await pool.query(
      'UPDATE tickets SET gm_approved_by_user_id = ?, gm_approved_at = NOW(), updated_at = NOW() WHERE id = ?',
      [req.user.id, req.params.id]
    );
    if (ticket.forwarded_by_user_id) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, 'ticket_ready', ?, ?, 'Ticket', ?)`,
        [ticket.forwarded_by_user_id, `${ticket.ticket_no} was approved by the GM`, 'This ticket can now be assigned.', req.params.id]
      );
    }

    const [[row]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.put('/:id/status', requireAuth, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });

    const [[ticket]] = await pool.query(
      'SELECT department_id, assigned_to_user_id, created_by_user_id, ticket_no FROM tickets WHERE id = ?',
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    const isAssignee = ticket.assigned_to_user_id === req.user.id;
    if (!isAssignee && !(await canManageTicket(req.user.id, ticket.department_id))) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }

    const isResolving = status === 'resolved';
    await pool.query(
      'UPDATE tickets SET status = ?, resolved_by_user_id = ?, resolved_at = ?, updated_at = NOW() WHERE id = ?',
      [status, isResolving ? req.user.id : null, isResolving ? new Date() : null, req.params.id]
    );

    // Notify the requester specifically, not the assignee/approver -- they're the one
    // who's been waiting on this and has no other reason to be watching the ticket.
    if (isResolving) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, 'ticket_resolved', ?, ?, 'Ticket', ?)`,
        [ticket.created_by_user_id, `${ticket.ticket_no} was resolved`, 'Your ticket has been marked resolved.', req.params.id]
      );
    }

    const [[row]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[ticket]] = await conn.query('SELECT department_id FROM tickets WHERE id = ?', [req.params.id]);
    if (!ticket) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }

    await conn.query('DELETE FROM ticket_messages WHERE ticket_id = ?', [req.params.id]);
    await conn.query('DELETE FROM ticket_approvers WHERE ticket_id = ?', [req.params.id]);
    await conn.query('DELETE FROM notifications WHERE related_type = ? AND related_id = ?', ['Ticket', req.params.id]);
    await conn.query('DELETE FROM tickets WHERE id = ?', [req.params.id]);

    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This ticket cannot be deleted because it is referenced by other data.' });
    }
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
