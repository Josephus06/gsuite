const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/employees';

// What every user who can see the employee list gets -- the directory. The list feeds pickers all
// over the app (Sales Rep, Prepared By ...), so 50-odd users read it. The employee PROFILE (2026-10-13,
// db/add-employee-profile.js) adds personal data, government numbers, bank details and pay, and none
// of that may ride along here: the list names its columns rather than selecting e.*.
const DIRECTORY_COLUMNS = ['id', 'employee_code', 'first_name', 'last_name', 'department_id', 'position_title',
  'email', 'phone', 'date_hired', 'is_active', 'created_at', 'updated_at'];

// The profile itself is HR's: Edit on Employees (can_edit) sees and changes all of it.
const isHr = (userId) => userCan(userId, ROUTE, 'can_edit');

// account_type filters to employees whose linked user account is that type (e.g.
// ?account_type=Artist for an Artist-only picker) -- joins through users.employee_id
// since account_type lives on the user account, not the employee record itself.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { account_type: accountType } = req.query;
    const where = [];
    const params = [];
    if (accountType) { where.push('u.account_type = ?'); params.push(accountType); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT DISTINCT ${DIRECTORY_COLUMNS.map((c) => `e.${c}`).join(', ')}, d.name AS department_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       ${accountType ? 'JOIN users u ON u.employee_id = e.id' : ''}
       ${whereSql}
       ORDER BY e.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// The profile's editable fields, by kind, so each is cleaned the same way on the way in.
const TEXT = {
  employee_code: 30, first_name: 100, last_name: 100, position_title: 150, email: 150, phone: 50,
  new_employee_no: 30, bank_account_no: 40, nickname: 60, middle_initial: 10, address: 255, birth_place: 150,
  sex: 10, nationality: 60, religion: 60, civil_status: 20, height: 20, weight: 20, blood_type: 5,
  educational_attainment: 60, course: 255, sss_no: 20, tin: 20, hdmf_no: 20, philhealth_no: 20,
  employment_status: 30, position_code: 30, biometric_user_id: 40, rest_day_group: 60, shift_group: 60,
  prof_license_no: 60, labor_type: 30, uniform_size: 10, shoe_size: 10, tax_status: 20, employment_type: 30,
  emergency_contact_name: 150, emergency_contact_address: 255, emergency_contact_phone: 50,
  emergency_contact_relationship: 60, spouse_name: 150, spouse_occupation: 100, bank_group: 60,
  compensation_group: 60, classification: 60, employee_level: 60, tams_id: 40,
};
const DATES = ['date_hired', 'birth_date', 'date_probationary', 'date_regularized', 'date_separated', 'license_expiry', 'eoc_date'];
const INTS = ['months_probation', 'months_regular', 'months_before_eoc', 'department_id', 'supervisor_employee_id'];
const FLAGS = ['is_active', 'no_lunch_policy', 'compute_ot_pay', 'compute_absences', 'is_confidential',
  'doc_ok_probationary', 'doc_ok_regular', 'is_special'];
const MONEY = ['pay_threshold'];
const MAX_PHOTO = 2 * 1024 * 1024; // a canvas-shrunk data URL is far below this

function clean(body, { profile }) {
  const out = {};
  const keys = (list) => list.filter((k) => body[k] !== undefined);
  for (const k of keys(Object.keys(TEXT))) {
    if (!profile && !['employee_code', 'first_name', 'last_name', 'position_title', 'email', 'phone'].includes(k)) continue;
    const v = body[k] == null ? '' : String(body[k]).trim();
    out[k] = v ? v.slice(0, TEXT[k]) : null;
  }
  for (const k of keys(DATES)) {
    if (!profile && k !== 'date_hired') continue;
    const v = String(body[k] || '').slice(0, 10);
    out[k] = /^\d{4}-\d{2}-\d{2}$/.test(v) && v !== '0000-00-00' ? v : null;
  }
  for (const k of keys(INTS)) {
    if (!profile && k !== 'department_id') continue;
    out[k] = body[k] === '' || body[k] == null || !Number.isFinite(Number(body[k])) ? null : Math.trunc(Number(body[k]));
  }
  for (const k of keys(FLAGS)) {
    if (!profile && k !== 'is_active') continue;
    const v = body[k];
    // is_active is never unknown; the others may be left blank ("not set" differs from "No").
    out[k] = v === '' || v == null ? (k === 'is_active' ? 1 : null) : (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
  }
  for (const k of keys(MONEY)) {
    if (!profile) continue;
    out[k] = body[k] === '' || body[k] == null || !Number.isFinite(Number(body[k])) ? null : Number(body[k]);
  }
  if (profile && body.photo_data !== undefined) {
    const p = body.photo_data ? String(body.photo_data) : '';
    out.photo_data = p && /^data:image\/(png|jpeg|webp);base64,/.test(p) && p.length <= MAX_PHOTO ? p : null;
  }
  return out;
}

// The pay rate in force on a date: the newest employee_compensation row on or before it.
async function currentPay(employeeId) {
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.effective_date, c.pay_type, c.base_rate, c.remarks, c.created_at, u.display_name AS created_by
         FROM employee_compensation c LEFT JOIN users u ON u.id = c.created_by_user_id
        WHERE c.employee_id = ? ORDER BY c.effective_date DESC`, [employeeId]);
    const today = new Date().toISOString().slice(0, 10);
    return { current: rows.find((r) => String(r.effective_date).slice(0, 10) <= today) || null, history: rows };
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return { current: null, history: [] };
    throw err;
  }
}

// Suggestions for the profile's company-specific lists (Rest Day Group, Bank Group, ...): what is
// already in use, so the same group is spelled the same way every time.
const OPTION_COLUMNS = ['religion', 'nationality', 'employment_status', 'position_code', 'rest_day_group', 'shift_group',
  'labor_type', 'employment_type', 'bank_group', 'compensation_group', 'classification', 'employee_level',
  'educational_attainment', 'uniform_size', 'shoe_size'];
router.get('/meta/profile-options', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const out = {};
    for (const c of OPTION_COLUMNS) {
      const [rows] = await pool.query(
        `SELECT DISTINCT ${c} AS v FROM employees WHERE ${c} IS NOT NULL AND ${c} <> '' ORDER BY ${c} LIMIT 200`)
        .catch((e) => { if (e.code === 'ER_BAD_FIELD_ERROR') return [[]]; throw e; });
      out[c] = rows.map((r) => r.v);
    }
    // Position Description is what links an employee to their Performance Evaluation template
    // (2026-10-23): offer the templates' positions first, so it is picked rather than retyped.
    const [tpl] = await pool.query('SELECT position_title AS v FROM perf_templates WHERE is_active = 1 ORDER BY position_title')
      .catch(() => [[]]);
    out.position_title = [...new Set([...tpl.map((r) => r.v), ...(out.position_title || [])])];
    res.json(out);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT e.*, d.name AS department_name, CONCAT(s.first_name, ' ', s.last_name) AS supervisor_name,
              u.display_name AS updated_by_name
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN employees s ON s.id = e.supervisor_employee_id
         LEFT JOIN users u ON u.id = e.updated_by_user_id
        WHERE e.id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!(await isHr(req.user.id))) {
      const dir = Object.fromEntries(DIRECTORY_COLUMNS.map((c) => [c, row[c]]));
      return res.json({ ...dir, department_name: row.department_name, profile_restricted: true });
    }
    res.json({ ...row, pay: await currentPay(row.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const values = clean(req.body, { profile: await isHr(req.user.id) });
    if (!values.first_name || !values.last_name) return res.status(400).json({ error: 'First and last name are required.' });
    if (values.is_active === undefined) values.is_active = 1;
    values.updated_by_user_id = req.user.id;
    const cols = Object.keys(values);
    const [result] = await pool.query(
      `INSERT INTO employees (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map((c) => values[c])
    );
    const [[row]] = await pool.query(`SELECT ${DIRECTORY_COLUMNS.join(', ')} FROM employees WHERE id = ?`, [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') return res.status(503).json({ error: 'Run db/add-employee-profile.js first.' });
    next(err);
  }
});

// Only the fields sent are changed, so the directory edit and the full profile share one route.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const values = clean(req.body, { profile: true });
    if (values.first_name === null || values.last_name === null) return res.status(400).json({ error: 'First and last name are required.' });
    if (Number(values.supervisor_employee_id) === Number(req.params.id)) return res.status(400).json({ error: 'An employee cannot be their own supervisor.' });
    values.updated_by_user_id = req.user.id;
    const cols = Object.keys(values);
    await pool.query(
      `UPDATE employees SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...cols.map((c) => values[c]), req.params.id]
    );
    const [[row]] = await pool.query(`SELECT ${DIRECTORY_COLUMNS.join(', ')} FROM employees WHERE id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') return res.status(503).json({ error: 'Run db/add-employee-profile.js first.' });
    next(err);
  }
});

// A pay rate, effective from a date. Adds a row; an earlier rate is never changed, so a past payroll
// still reads what it paid. A second entry for the SAME date corrects that day's entry.
const PAY_TYPES = ['monthly', 'daily'];
router.post('/:id/pay-rate', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const rate = Number(req.body.base_rate);
    const payType = PAY_TYPES.includes(req.body.pay_type) ? req.body.pay_type : null;
    const eff = String(req.body.effective_date || '').slice(0, 10);
    if (!payType) return res.status(400).json({ error: 'Choose the pay type: Monthly or Daily.' });
    if (!Number.isFinite(rate) || rate <= 0) return res.status(400).json({ error: 'Enter the pay rate.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eff)) return res.status(400).json({ error: 'Enter the date the rate takes effect.' });
    const [[emp]] = await pool.query('SELECT id FROM employees WHERE id = ?', [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'Not found' });
    await pool.query(
      `INSERT INTO employee_compensation (employee_id, effective_date, pay_type, base_rate, remarks, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE pay_type = VALUES(pay_type), base_rate = VALUES(base_rate), remarks = VALUES(remarks),
                               created_by_user_id = VALUES(created_by_user_id)`,
      [emp.id, eff, payType, rate, req.body.remarks ? String(req.body.remarks).slice(0, 255) : null, req.user.id]);
    res.json(await currentPay(emp.id));
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'Run db/add-employee-profile.js first.' });
    next(err);
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM employees WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This employee is referenced by other data (e.g. a user account) and cannot be deleted.' });
    }
    next(err);
  }
});

module.exports = router;
