const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/pms-job-types';

const FIELDS = ['code', 'display_name', 'minutes_consume', 'job_type_id', 'department_id'];

async function logAudit(conn, { pmsJobTypeId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('PmsJobType', ?, ?, ?, ?, ?, ?)`,
    [pmsJobTypeId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search } = req.query;
    const where = [];
    const params = [];
    if (search) {
      where.push('(p.code LIKE ? OR p.display_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT p.*, jt.display_name AS job_type_name, d.name AS department_name
       FROM pms_job_types p
       LEFT JOIN job_types jt ON jt.id = p.job_type_id
       LEFT JOIN departments d ON d.id = p.department_id
       ${whereSql}
       ORDER BY p.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT p.*, jt.display_name AS job_type_name, d.name AS department_name
       FROM pms_job_types p
       LEFT JOIN job_types jt ON jt.id = p.job_type_id
       LEFT JOIN departments d ON d.id = p.department_id
       WHERE p.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'PmsJobType' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const values = FIELDS.map((f) => (req.body[f] === undefined || req.body[f] === '' ? null : req.body[f]));
    const [result] = await pool.query(
      `INSERT INTO pms_job_types (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
      values
    );
    const [[row]] = await pool.query('SELECT * FROM pms_job_types WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Code already in use' });
    next(err);
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[before]] = await conn.query('SELECT * FROM pms_job_types WHERE id = ?', [req.params.id]);
    if (!before) { conn.release(); return res.status(404).json({ error: 'Not found' }); }

    const values = FIELDS.map((f) => (req.body[f] === undefined || req.body[f] === '' ? null : req.body[f]));

    await conn.beginTransaction();
    await conn.query(
      `UPDATE pms_job_types SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.id]
    );
    for (const f of FIELDS) {
      const oldVal = before[f];
      const newVal = req.body[f] === undefined || req.body[f] === '' ? null : req.body[f];
      if (String(oldVal ?? '') !== String(newVal ?? '')) {
        await logAudit(conn, { pmsJobTypeId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: f, oldValue: oldVal, newValue: newVal });
      }
    }
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM pms_job_types WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM pms_job_types WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This job type is referenced by other data and cannot be deleted.' });
    }
    next(err);
  }
});

module.exports = router;
