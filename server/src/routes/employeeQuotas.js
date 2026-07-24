const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
// Employee Quota (Commission > Setups > Employee Quota). A monthly sales target per
// employee, set by hand. The list is the employees themselves; drilling into one shows
// its per-month quota rows. Registered by src/db/create-commission-module.js.
const ROUTE = '/employee-quotas';

// Quotas are only for sales users, so the list is scoped to active employees whose linked
// user account is a Sales account -- not all 100+ employees. account_type = 'Sales' is the
// exact set of salespeople (the is_sales_* flags aren't the gate: they decide which
// commission scheme applies to a rep, and the admin carries every flag, which would leak
// them into the list). Each row still carries a rollup of what's been set so they can be
// scanned at a glance, including reps with no quota yet -- setting the first one is the
// whole point of opening the page.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search } = req.query;
    const where = [
      'e.is_active = TRUE',
      "EXISTS (SELECT 1 FROM users u WHERE u.employee_id = e.id AND u.is_active = TRUE AND u.account_type = 'Sales')",
    ];
    const params = [];
    if (search) {
      where.push("(CONCAT(e.first_name, ' ', e.last_name) LIKE ? OR e.employee_code LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    const [rows] = await pool.query(
      `SELECT e.id, e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
              e.position_title, d.name AS department_name,
              COUNT(eq.id) AS quota_count,
              MAX(eq.year) AS latest_year
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN employee_quotas eq ON eq.employee_id = e.id
       WHERE ${where.join(' AND ')}
       GROUP BY e.id
       ORDER BY employee_name`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:employeeId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[employee]] = await pool.query(
      `SELECT e.id, e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
              e.position_title, d.name AS department_name, e.created_at
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.id = ?`,
      [req.params.employeeId]
    );
    if (!employee) return res.status(404).json({ error: 'Not found' });
    const [quotas] = await pool.query(
      `SELECT id, year, month, quota FROM employee_quotas
       WHERE employee_id = ? ORDER BY year DESC, month DESC`,
      [req.params.employeeId]
    );
    res.json({ ...employee, quotas });
  } catch (err) {
    next(err);
  }
});

// Save replaces this employee's quota rows in one shot -- the whole grid is edited as a
// page, so the transaction clears and re-inserts. Each row is one (year, month) target;
// the unique key guards against the same month being entered twice.
router.put('/:employeeId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[employee]] = await conn.query('SELECT id FROM employees WHERE id = ?', [req.params.employeeId]);
    if (!employee) { conn.release(); return res.status(404).json({ error: 'Not found' }); }

    const quotas = Array.isArray(req.body.quotas) ? req.body.quotas : [];
    const seen = new Set();
    for (const q of quotas) {
      const year = Number(q.year);
      const month = Number(q.month);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        conn.release(); return res.status(400).json({ error: 'Every quota row needs a valid Year.' });
      }
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        conn.release(); return res.status(400).json({ error: 'Every quota row needs a Month (1-12).' });
      }
      const key = `${year}-${month}`;
      if (seen.has(key)) {
        conn.release();
        return res.status(409).json({ error: `${year}-${String(month).padStart(2, '0')} is entered twice. Each month can only have one quota.` });
      }
      seen.add(key);
    }

    await conn.beginTransaction();
    await conn.query('DELETE FROM employee_quotas WHERE employee_id = ?', [req.params.employeeId]);
    for (const q of quotas) {
      await conn.query(
        'INSERT INTO employee_quotas (employee_id, year, month, quota, created_by_user_id) VALUES (?, ?, ?, ?, ?)',
        [req.params.employeeId, Number(q.year), Number(q.month), Number(q.quota) || 0, req.user.id]
      );
    }
    await conn.commit();

    const [quotasOut] = await pool.query(
      'SELECT id, year, month, quota FROM employee_quotas WHERE employee_id = ? ORDER BY year DESC, month DESC',
      [req.params.employeeId]
    );
    res.json({ employee_id: Number(req.params.employeeId), quotas: quotasOut });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
