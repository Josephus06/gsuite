const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/non-standard-job-orders';
const JOB_TYPES = new Set(['CUTTING LIST', 'DPOD-FILE PREPARATION LAYOUT', 'LED PRODUCT DEMO', 'SITE INSPECTION']);
const SITE_INSPECTION_SUBTYPES = new Set(['INITIAL SITE INSPECTION', 'FINAL SITE INSPECTION']);

async function defaultBranch(userId) {
  const [[branch]] = await pool.query(
    `SELECT u.employee_id, ub.location_id, ub.department_id AS sales_division_id
       FROM users u
       LEFT JOIN user_branches ub ON ub.user_id = u.id AND ub.is_default = TRUE
      WHERE u.id = ?`,
    [userId],
  );
  return branch || {};
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [customers, employees, locations, divisions, pmsJobTypes, defaults] = await Promise.all([
      pool.query('SELECT id, name FROM customers WHERE is_active = TRUE ORDER BY name'),
      pool.query('SELECT id, first_name, last_name FROM employees WHERE is_active = TRUE ORDER BY first_name, last_name'),
      pool.query('SELECT id, location_name FROM locations WHERE is_active = TRUE ORDER BY location_name'),
      pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name'),
      pool.query('SELECT id, code, display_name FROM pms_job_types ORDER BY display_name'),
      defaultBranch(req.user.id),
    ]);
    res.json({ customers: customers[0], employees: employees[0], locations: locations[0], divisions: divisions[0], pmsJobTypes: pmsJobTypes[0], defaults });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search = '', page = 1, limit = 10 } = req.query;
    const params = [];
    const where = search ? 'WHERE n.nstdjo_no LIKE ? OR n.description LIKE ? OR c.name LIKE ?' : '';
    if (search) params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    const from = `FROM non_standard_job_orders n
      JOIN customers c ON c.id = n.customer_id
      LEFT JOIN employees e ON e.id = n.sales_rep_id
      LEFT JOIN departments d ON d.id = n.sales_division_id
      LEFT JOIN pms_job_types pjt ON pjt.id = n.pms_job_type_id`;
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) total ${from} ${where}`, params);
    const size = Math.min(100, Math.max(1, Number(limit)));
    const current = Math.max(1, Number(page));
    const [rows] = await pool.query(
      `SELECT n.*, c.name customer_name, d.name sales_division_name,
              CONCAT(e.first_name, ' ', e.last_name) sales_rep_name,
              pjt.code pms_job_type_code, pjt.display_name pms_job_type_name
         ${from} ${where} ORDER BY n.id DESC LIMIT ? OFFSET ?`,
      [...params, size, (current - 1) * size],
    );
    res.json({ rows, total, page: current, limit: size });
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const h = req.body || {};
    const branch = await defaultBranch(req.user.id);
    const jobLocationId = branch.location_id || h.job_location_id;
    if (!h.customer_id || !jobLocationId || !h.description?.trim() || !h.quantity || Number(h.quantity) <= 0 || !h.delivery_date) return res.status(400).json({ error: 'Customer, job location, description, positive quantity, and delivery date are required.' });
    if (!JOB_TYPES.has(h.job_type)) return res.status(400).json({ error: 'Choose a valid non-standard job type.' });
    if (h.job_type === 'SITE INSPECTION' && !SITE_INSPECTION_SUBTYPES.has(h.site_inspection_subtype)) return res.status(400).json({ error: 'Choose a valid Site Inspection subtype.' });
    if (!branch.employee_id) return res.status(400).json({ error: 'Your user account needs an assigned employee before a non-standard job order can be saved.' });
    if (!branch.sales_division_id) return res.status(400).json({ error: 'Your default User Branch needs a department before a non-standard job order can be saved.' });
    if (h.pms_job_type_id) {
      const [[pmsJobType]] = await conn.query('SELECT id FROM pms_job_types WHERE id = ?', [h.pms_job_type_id]);
      if (!pmsJobType) return res.status(400).json({ error: 'The selected PMS Job Type no longer exists.' });
    }
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO non_standard_job_orders
       (nstdjo_no, customer_id, contact_email, contact_title, contact_phone, memo, date_created,
        job_location_id, job_type, site_inspection_subtype, pms_job_type_id, description, quantity,
        shipping_address, delivery_date, delivery_time, sales_rep_id, sales_division_id, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['PENDING', h.customer_id, h.contact_email || null, h.contact_title || null, h.contact_phone || null, h.memo || null,
        h.date_created || new Date().toISOString().slice(0, 10), jobLocationId, h.job_type,
        h.job_type === 'SITE INSPECTION' ? h.site_inspection_subtype : null, h.pms_job_type_id || null,
        h.description.trim(), h.quantity, h.shipping_address || null, h.delivery_date, h.delivery_time || null,
        branch.employee_id, branch.sales_division_id, req.user.id],
    );
    const nstdjoNo = `NSTDJO-${result.insertId}`;
    await conn.query('UPDATE non_standard_job_orders SET nstdjo_no = ? WHERE id = ?', [nstdjoNo, result.insertId]);
    await conn.commit();
    res.status(201).json({ id: result.insertId, nstdjo_no: nstdjoNo });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

module.exports = router;
