const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/users';

// "Account Type" tab fields (step 4 of the real system's Add/Update User wizard).
const ACCOUNT_TYPE_FIELDS = [
  'user_group_id', 'account_type', 'can_approve_sales_estimate', 'is_account_officer',
  'is_supervisor', 'is_sales_manager', 'is_sales_marketing_director', 'is_sales_business_unit',
  'is_design_supervisor', 'approval_code', 'supervisor_id',
];

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.email, u.display_name, u.employee_id, u.default_branch_id,
              u.is_active, u.last_login_at, u.created_at, u.account_type, u.supervisor_id,
              CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
              l.location_name AS default_branch_name,
              su.display_name AS supervisor_name
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
       LEFT JOIN locations l ON l.id = u.default_branch_id
       LEFT JOIN users su ON su.id = u.supervisor_id
       ORDER BY u.id DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/meta/pages', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, name, route, parent_page_id, sort_order FROM pages WHERE is_active = TRUE ORDER BY sort_order, id');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[user]] = await pool.query(
      `SELECT id, username, email, display_name, employee_id, default_branch_id, is_active, last_login_at, created_at,
              ${ACCOUNT_TYPE_FIELDS.join(', ')}
       FROM users WHERE id = ?`,
      [req.params.id]
    );
    if (!user) return res.status(404).json({ error: 'Not found' });

    const [branches] = await pool.query(
      'SELECT id, location_id, department_id, can_override_date, remarks, is_default FROM user_branches WHERE user_id = ?',
      [req.params.id]
    );
    const [permissions] = await pool.query(
      'SELECT page_id, can_view, can_add, can_edit, can_delete, can_approve FROM user_page_permissions WHERE user_id = ?',
      [req.params.id]
    );

    res.json({ ...user, branches, permissions });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const { username, email, password, display_name, employee_id, default_branch_id, is_active } = req.body;
    if (!username || !email || !password || !display_name) {
      return res.status(400).json({ error: 'username, email, password, and display_name are required' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const accountTypeValues = ACCOUNT_TYPE_FIELDS.map((f) => (req.body[f] === undefined || req.body[f] === '' ? null : req.body[f]));
    const [result] = await pool.query(
      `INSERT INTO users (employee_id, username, email, password_hash, display_name, default_branch_id, is_active, ${ACCOUNT_TYPE_FIELDS.join(', ')})
       VALUES (?, ?, ?, ?, ?, ?, ?, ${ACCOUNT_TYPE_FIELDS.map(() => '?').join(', ')})`,
      [employee_id || null, username, email, passwordHash, display_name, default_branch_id || null, is_active ?? true, ...accountTypeValues]
    );
    const [[row]] = await pool.query(
      `SELECT id, username, email, display_name, employee_id, default_branch_id, is_active, ${ACCOUNT_TYPE_FIELDS.join(', ')} FROM users WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username or email already in use' });
    next(err);
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { email, password, display_name, employee_id, default_branch_id, is_active } = req.body;
    const accountTypeValues = ACCOUNT_TYPE_FIELDS.map((f) => (req.body[f] === undefined || req.body[f] === '' ? null : req.body[f]));
    const fields = [
      'email = ?', 'display_name = ?', 'employee_id = ?', 'default_branch_id = ?', 'is_active = ?',
      ...ACCOUNT_TYPE_FIELDS.map((f) => `${f} = ?`),
    ];
    const values = [email, display_name, employee_id || null, default_branch_id || null, is_active ?? true, ...accountTypeValues];

    if (password) {
      fields.push('password_hash = ?');
      values.push(await bcrypt.hash(password, 10));
    }

    await pool.query(`UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, [...values, req.params.id]);
    const [[row]] = await pool.query(
      `SELECT id, username, email, display_name, employee_id, default_branch_id, is_active, ${ACCOUNT_TYPE_FIELDS.join(', ')} FROM users WHERE id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already in use' });
    next(err);
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM user_page_permissions WHERE user_id = ?', [req.params.id]);
      await conn.query('DELETE FROM user_branches WHERE user_id = ?', [req.params.id]);
      await conn.query('DELETE FROM users WHERE id = ?', [req.params.id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.put('/:id/branches', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const branches = Array.isArray(req.body.branches) ? req.body.branches : [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM user_branches WHERE user_id = ?', [req.params.id]);
      for (const b of branches) {
        await conn.query(
          `INSERT INTO user_branches (user_id, location_id, department_id, can_override_date, remarks, is_default)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [req.params.id, b.location_id, b.department_id || null, !!b.can_override_date, b.remarks || null, !!b.is_default]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/permissions', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM user_page_permissions WHERE user_id = ?', [req.params.id]);
      for (const p of permissions) {
        if (!p.can_view && !p.can_add && !p.can_edit && !p.can_delete && !p.can_approve) continue;
        await conn.query(
          `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [req.params.id, p.page_id, !!p.can_view, !!p.can_add, !!p.can_edit, !!p.can_delete, !!p.can_approve]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
