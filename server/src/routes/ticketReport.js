const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ticketVisibilityClause } = require('../lib/ticketVisibility');

const router = express.Router();

// GET / -> report (CSV or JSON)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { sql: visSql, params: visParams } = await ticketVisibilityClause(req.user.id);
    const params = [...visParams];
    let dateFilter = '';
    if (req.query.asOf) {
      dateFilter = 'AND t.created_at <= ?';
      params.push(req.query.asOf + ' 23:59:59');
    } else if (req.query.from && req.query.to) {
      dateFilter = 'AND t.created_at BETWEEN ? AND ?';
      params.push(req.query.from + ' 00:00:00', req.query.to + ' 23:59:59');
    }

    const [rows] = await pool.query(
      `SELECT t.ticket_no, d.name AS department_name, cu.display_name AS created_by_name,
              t.created_at, ab.display_name AS approved_by_name, t.approved_at,
              gb.display_name AS gm_approved_by_name, t.gm_approved_at,
              au.display_name AS assigned_to_name, t.assigned_at, ru.display_name AS resolved_by_name, t.resolved_at
       FROM tickets t
       JOIN departments d ON d.id = t.department_id
       LEFT JOIN users cu ON cu.id = t.created_by_user_id
       LEFT JOIN users au ON au.id = t.assigned_to_user_id
       LEFT JOIN users ab ON ab.id = t.approved_by_user_id
       LEFT JOIN users gb ON gb.id = t.gm_approved_by_user_id
       LEFT JOIN users ru ON ru.id = t.resolved_by_user_id
       WHERE ${visSql} ${dateFilter}
       ORDER BY t.id DESC`,
      params
    );

    const total = rows.length;
    const resolved = rows.filter((r) => r.resolved_at).length;
    const unresolved = total - resolved;

    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const headers = [
        'ticket_no','department_name','created_by','created_at','approved_by','approved_at','gm_approved_by','gm_approved_at','assigned_to','assigned_at','resolved_by','resolved_at'
      ];
      const escape = (v) => (v == null ? '' : String(v).replace(/"/g, '""'));
      const lines = [headers.join(',')];
      for (const r of rows) {
        const vals = [r.ticket_no, r.department_name, r.created_by_name, r.created_at, r.approved_by_name, r.approved_at, r.gm_approved_by_name, r.gm_approved_at, r.assigned_to_name, r.assigned_at, r.resolved_by_name, r.resolved_at];
        lines.push(vals.map((c) => `"${escape(c)}"`).join(','));
      }
      lines.push('');
      lines.push(`Total tickets:,${total}`);
      lines.push(`Resolved tickets:,${resolved}`);
      lines.push(`Unresolved tickets:,${unresolved}`);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="ticket-report.csv"');
      return res.send(lines.join('\n'));
    }

    res.json({ rows, summary: { total, resolved, unresolved } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
