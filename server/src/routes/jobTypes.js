const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/job-types';

const FIELDS = [
  'item_code', 'display_name', 'sales_description', 'purchase_description', 'jo_type',
  'parent_job_type_id', 'department_id',
  'unit_type', 'stock_unit', 'purchase_unit', 'sales_unit', 'base_unit',
  'is_area', 'is_piece', 'is_for_sample', 'is_direct_to_prod', 'is_ecommerce',
  'income_account_id', 'cogs_account_id', 'asset_account_id',
  'gp_rate_head', 'gp_rate_branch', 'is_active',
];

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search } = req.query;
    const where = [];
    const params = [];
    if (search) {
      where.push('(jt.display_name LIKE ? OR jt.item_code LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT jt.*, ca.account_code AS cogs_account_code, ca.account_name AS cogs_account_name,
              aa.account_code AS asset_account_code, aa.account_name AS asset_account_name,
              ia.account_code AS income_account_code, ia.account_name AS income_account_name
       FROM job_types jt
       LEFT JOIN chart_of_accounts ca ON ca.id = jt.cogs_account_id
       LEFT JOIN chart_of_accounts aa ON aa.id = jt.asset_account_id
       LEFT JOIN chart_of_accounts ia ON ia.id = jt.income_account_id
       ${whereSql}
       ORDER BY jt.display_name`,
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
      `SELECT jt.*, d.name AS department_name, pjt.display_name AS parent_job_type_name,
              ca.account_code AS cogs_account_code, ca.account_name AS cogs_account_name,
              aa.account_code AS asset_account_code, aa.account_name AS asset_account_name,
              ia.account_code AS income_account_code, ia.account_name AS income_account_name
       FROM job_types jt
       LEFT JOIN departments d ON d.id = jt.department_id
       LEFT JOIN job_types pjt ON pjt.id = jt.parent_job_type_id
       LEFT JOIN chart_of_accounts ca ON ca.id = jt.cogs_account_id
       LEFT JOIN chart_of_accounts aa ON aa.id = jt.asset_account_id
       LEFT JOIN chart_of_accounts ia ON ia.id = jt.income_account_id
       WHERE jt.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    const [processes] = await pool.query(
      `SELECT jtp.*, p.process_code, p.process_name
       FROM job_type_processes jtp
       JOIN processes p ON p.id = jtp.process_id
       WHERE jtp.job_type_id = ? ORDER BY jtp.sort_order, jtp.id`,
      [req.params.id]
    );
    const [customers] = await pool.query(
      `SELECT jtc.*, c.customer_code, c.name AS customer_name
       FROM job_type_customers jtc
       JOIN customers c ON c.id = jtc.customer_id
       WHERE jtc.job_type_id = ? ORDER BY jtc.id`,
      [req.params.id]
    );

    res.json({ ...row, processes, customers });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const body = { ...req.body };
    const values = FIELDS.map((f) => (body[f] === undefined || body[f] === '' ? null : body[f]));
    const [result] = await pool.query(
      `INSERT INTO job_types (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
      values
    );
    const [[row]] = await pool.query('SELECT * FROM job_types WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Display name already in use' });
    next(err);
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[before]] = await pool.query('SELECT id FROM job_types WHERE id = ?', [req.params.id]);
    if (!before) return res.status(404).json({ error: 'Not found' });

    const body = { ...req.body };
    const values = FIELDS.map((f) => (body[f] === undefined || body[f] === '' ? null : body[f]));
    await pool.query(
      `UPDATE job_types SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.id]
    );

    const [[row]] = await pool.query('SELECT * FROM job_types WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM job_type_processes WHERE job_type_id = ?', [req.params.id]);
    await conn.query('DELETE FROM job_type_customers WHERE job_type_id = ?', [req.params.id]);
    await conn.query('DELETE FROM job_types WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This job type is referenced by other data and cannot be deleted.' });
    }
    next(err);
  } finally {
    conn.release();
  }
});

router.post('/:id/processes', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { process_id } = req.body;
    const [[{ maxSort }]] = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM job_type_processes WHERE job_type_id = ?',
      [req.params.id]
    );
    const [result] = await pool.query(
      'INSERT INTO job_type_processes (job_type_id, process_id, sort_order) VALUES (?, ?, ?)',
      [req.params.id, process_id, maxSort + 1]
    );
    const [[row]] = await pool.query(
      `SELECT jtp.*, p.process_code, p.process_name FROM job_type_processes jtp
       JOIN processes p ON p.id = jtp.process_id WHERE jtp.id = ?`,
      [result.insertId]
    );
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This process is already assigned to this job type.' });
    next(err);
  }
});

router.delete('/:id/processes/:processLinkId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM job_type_processes WHERE id = ? AND job_type_id = ?', [req.params.processLinkId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/customers', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { customer_id, gp_rate } = req.body;
    const [result] = await pool.query(
      'INSERT INTO job_type_customers (job_type_id, customer_id, gp_rate) VALUES (?, ?, ?)',
      [req.params.id, customer_id, gp_rate || 0]
    );
    const [[row]] = await pool.query(
      `SELECT jtc.*, c.customer_code, c.name AS customer_name FROM job_type_customers jtc
       JOIN customers c ON c.id = jtc.customer_id WHERE jtc.id = ?`,
      [result.insertId]
    );
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This customer already has a GP Rate override for this job type.' });
    next(err);
  }
});

router.delete('/:id/customers/:customerLinkId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM job_type_customers WHERE id = ? AND job_type_id = ?', [req.params.customerLinkId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
