const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// HRD > Certificate of Employment (2026-10-22). HR picks the employee, the name, position and service
// dates fill in from the employee record, and the certificate prints on the company's own template.
//
// Two templates, the two the company already uses:
//   standard     the plain COE -- "has been employed with ... from ... to ..."
//   with_rating  the separation COE -- "was employed with ...", then the Performance Appraisal prior
//                to separation, Mode of Separation and Clearance Status.
//
// The row keeps its own copy of what was printed. A certificate is a document already handed to
// somebody; renaming the employee or changing their position afterwards must not reword it.
const ROUTE = '/hrd/coe';
const TYPES = ['standard', 'with_rating'];
const PRONOUNS = ['he', 'she', 'either'];

// The five appraisal lines of the rating template, in its order, with the template's own remarks as
// the starting text. HR changes the remark per employee; the criteria themselves are the template's.
const RATING_CRITERIA = [
  { key: 'rules', label: 'Company rules & Regulations',
    remarks: 'Complies with company policies and code of conduct most of the time.' },
  { key: 'competencies', label: 'Job Competencies',
    remarks: 'Competent during active duty and is willing to help with all his capabilities and knowledgeable in his responsibilities.' },
  { key: 'responsibilities', label: 'Key Job Responsibilities',
    remarks: 'Consistently delivers quality output; however, further improvement is needed to meet performance targets.' },
  { key: 'core_values', label: 'Core Values (Growth, Frugality, Excellence, Stewardship, Teamwork, Attitude, Respect)',
    remarks: 'Shows commitment to excellence, teamwork, and positive attitude.' },
  { key: 'attendance', label: 'Attendance',
    remarks: 'With good attendance performance.' },
];

const trunc = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// Ratings are stored as the five criteria in the template's order, whatever order or extra keys the
// client sends: the printed table is the template's, not the request's.
function cleanRatings(input) {
  const given = Array.isArray(input) ? input : [];
  return RATING_CRITERIA.map((c) => {
    const r = given.find((g) => g && g.key === c.key) || {};
    return { key: c.key, label: c.label, rating: trunc(r.rating, 40) || '', remarks: trunc(r.remarks, 500) || '' };
  });
}

function parseRow(r) {
  if (!r) return r;
  let ratings = r.ratings;
  if (typeof ratings === 'string') { try { ratings = JSON.parse(ratings); } catch { ratings = null; } }
  return { ...r, ratings: ratings || null };
}

async function nextNumber(conn) {
  const [[row]] = await conn.query(
    "SELECT MAX(CAST(SUBSTRING(coe_no, 5) AS UNSIGNED)) AS n FROM hr_coes WHERE coe_no LIKE 'COE-%' FOR UPDATE",
  );
  return `COE-${String((Number(row.n) || 0) + 1).padStart(4, '0')}`;
}

function readBody(body) {
  const coeType = TYPES.includes(body.coe_type) ? body.coe_type : null;
  if (!coeType) return { error: 'Choose the certificate: COE or COE with rating.' };
  const employeeName = trunc(body.employee_name, 200);
  if (!employeeName) return { error: 'Choose the employee.' };
  if (!isDate(body.issued_date)) return { error: 'Enter the date the certificate is issued.' };
  if (body.date_from && !isDate(body.date_from)) return { error: 'The From date is not a date.' };
  if (body.date_to && !isDate(body.date_to)) return { error: 'The To date is not a date.' };
  if (!body.date_from) return { error: 'Enter the date the employment started.' };
  // The rating template is the separation certificate: "was employed ... to ___" needs an end date.
  if (coeType === 'with_rating' && !body.date_to) return { error: 'A COE with rating needs the last day of employment (To).' };
  if (body.date_to && body.date_to < body.date_from) return { error: 'To is before From.' };
  return {
    values: {
      coe_type: coeType,
      employee_id: body.employee_id ? Number(body.employee_id) || null : null,
      employee_name: employeeName,
      position_title: trunc(body.position_title, 150),
      date_from: body.date_from,
      date_to: body.date_to || null,
      pronoun: PRONOUNS.includes(body.pronoun) ? body.pronoun : 'either',
      issued_to: trunc(body.issued_to, 200),
      issued_date: body.issued_date,
      ratings: coeType === 'with_rating' ? JSON.stringify(cleanRatings(body.ratings)) : null,
      mode_of_separation: coeType === 'with_rating' ? trunc(body.mode_of_separation, 150) : null,
      clearance_status: coeType === 'with_rating' ? trunc(body.clearance_status, 150) : null,
      signatory_name: trunc(body.signatory_name, 150) || 'JIMMY W. WU',
      signatory_title: trunc(body.signatory_title, 150) || 'General Manager',
      remarks: trunc(body.remarks, 500),
    },
  };
}

const BASE_SELECT = `
  SELECT c.*, u.display_name AS created_by_name, e.employee_code
    FROM hr_coes c
    LEFT JOIN users u ON u.id = c.created_by_user_id
    LEFT JOIN employees e ON e.id = c.employee_id`;

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (TYPES.includes(req.query.type)) { where.push('c.coe_type = ?'); params.push(req.query.type); }
    if (req.query.search) {
      where.push('(c.coe_no LIKE ? OR c.employee_name LIKE ? OR c.position_title LIKE ? OR c.issued_to LIKE ?)');
      const q = `%${req.query.search}%`;
      params.push(q, q, q, q);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(`${BASE_SELECT} ${whereSql} ORDER BY c.issued_date DESC, c.id DESC LIMIT 500`, params);
    res.json(rows.map(parseRow));
  } catch (err) { next(err); }
});

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), (req, res) => {
  res.json({ criteria: RATING_CRITERIA });
});

// Employee lookup. Separated employees included -- the rating COE is issued on separation, so the
// people it is for are mostly no longer active.
router.get('/employees', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const q = String(req.query.search || '').trim();
    const params = [];
    const where = [];
    if (q) {
      where.push(`(CONCAT_WS(' ', e.first_name, e.last_name) LIKE ? OR e.employee_code LIKE ?
                   OR d.name LIKE ? OR e.position_title LIKE ?)`);
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const [rows] = await pool.query(
      `SELECT e.id, e.employee_code, e.first_name, e.middle_initial, e.last_name,
              CONCAT_WS(' ', e.first_name, e.last_name) AS employee_name,
              e.position_title, e.date_hired, e.date_separated, e.sex, e.is_active,
              d.name AS department_name
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.is_active DESC, employee_name
        LIMIT 50`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(`${BASE_SELECT} WHERE c.id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Certificate not found' });
    res.json(parseRow(row));
  } catch (err) { next(err); }
});

router.get('/:id/print', requireAuth, requirePermission(ROUTE, 'can_print'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(`${BASE_SELECT} WHERE c.id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Certificate not found' });
    res.json(parseRow(row));
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const { error, values } = readBody(req.body || {});
  if (error) return res.status(400).json({ error });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const coeNo = await nextNumber(conn);
    const cols = Object.keys(values);
    const [r] = await conn.query(
      `INSERT INTO hr_coes (coe_no, ${cols.join(', ')}, created_by_user_id) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
      [coeNo, ...cols.map((c) => values[c]), req.user.id],
    );
    await conn.commit();
    const [[row]] = await pool.query(`${BASE_SELECT} WHERE c.id = ?`, [r.insertId]);
    res.status(201).json(parseRow(row));
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { error, values } = readBody(req.body || {});
    if (error) return res.status(400).json({ error });
    const cols = Object.keys(values);
    const [r] = await pool.query(
      `UPDATE hr_coes SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map((c) => values[c]), req.params.id],
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Certificate not found' });
    const [[row]] = await pool.query(`${BASE_SELECT} WHERE c.id = ?`, [req.params.id]);
    res.json(parseRow(row));
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [r] = await pool.query('DELETE FROM hr_coes WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Certificate not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
