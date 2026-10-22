const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, isSystemAdmin } = require('../middleware/auth');

const router = express.Router();

// HRD > Certificate of Employment (2026-10-22). HR picks the employee, the name, position and service
// dates fill in from the employee record, and the certificate prints on the company's own template.
//
// Two templates, the two the company already uses:
//   standard     the plain COE -- "has been employed with ... from ... to ..."
//   with_rating  the separation COE -- "was employed with ...", then the Performance Appraisal prior
//                to separation, Mode of Separation and Clearance Status.
//
// Every certificate goes to a General Manager for approval (2026-10-22). HR picks which one -- there
// can be two -- and it is signed in the name of the GM who approved it: the approver confirms the
// name as it is printed when approving. Until then it prints with a NOT YET APPROVED watermark and
// no name on the signature line. Editing a certificate sends it back for approval.
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
      approver_user_id: Number(body.approver_user_id) || null,
      remarks: trunc(body.remarks, 500),
    },
  };
}

const BASE_SELECT = `
  SELECT c.*, u.display_name AS created_by_name, e.employee_code, a.display_name AS approver_name
    FROM hr_coes c
    LEFT JOIN users u ON u.id = c.created_by_user_id
    LEFT JOIN users a ON a.id = c.approver_user_id
    LEFT JOIN employees e ON e.id = c.employee_id`;

// The General Managers: whoever is assigned in general_managers, plus any General Manager account.
// Each with the name a certificate would carry: the one they confirmed on their last approval, else
// the name on their employee record, else their display name.
async function generalManagers() {
  const [rows] = await pool.query(
    `SELECT u.id, u.display_name, e.first_name, e.middle_initial, e.last_name,
            (SELECT c.signatory_name FROM hr_coes c WHERE c.approver_user_id = u.id AND c.status = 'approved'
              ORDER BY c.approved_at DESC LIMIT 1) AS last_signed_as
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.is_active = 1
        AND (u.id IN (SELECT user_id FROM general_managers) OR u.account_type = 'General Manager')
      ORDER BY u.id`);
  return rows.map((r) => {
    const mi = r.middle_initial ? `${String(r.middle_initial).replace(/\.$/, '')}.` : '';
    const fromEmployee = [r.first_name, mi, r.last_name].filter(Boolean).join(' ');
    return {
      id: Number(r.id),
      display_name: r.display_name,
      sign_as: (r.last_signed_as || fromEmployee || r.display_name || '').toUpperCase(),
    };
  });
}

async function checkApprover(values) {
  const gms = await generalManagers();
  if (!gms.length) return 'There is no General Manager to approve it. Assign one first.';
  if (!values.approver_user_id) values.approver_user_id = gms[0].id;
  if (!gms.some((g) => g.id === values.approver_user_id)) return 'The approver must be a General Manager.';
  return null;
}

// After the change has committed; a failed notification is logged, never fatal.
async function notify(userIds, { type, title, message }, coeId, actorId) {
  const ids = [...new Set(userIds.map(Number).filter((id) => id && id !== Number(actorId)))];
  for (const userId of ids) {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
       VALUES (?, ?, ?, ?, 'HrCoe', ?)`,
      [userId, type, String(title).slice(0, 255), String(message).slice(0, 500), coeId],
    ).catch((err) => console.error('[notifications] COE:', err.message));
  }
}

const askApproval = (row, actorId) => notify([row.approver_user_id], {
  type: 'coe_for_approval',
  title: `${row.coe_no} needs your approval`,
  message: `Certificate of Employment for ${row.employee_name} is waiting for your approval.`,
}, row.id, actorId);

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (TYPES.includes(req.query.type)) { where.push('c.coe_type = ?'); params.push(req.query.type); }
    if (['for_approval', 'approved', 'rejected'].includes(req.query.status)) { where.push('c.status = ?'); params.push(req.query.status); }
    if (req.query.search) {
      where.push('(c.coe_no LIKE ? OR c.employee_name LIKE ? OR c.position_title LIKE ? OR c.issued_to LIKE ?)');
      const q = `%${req.query.search}%`;
      params.push(q, q, q, q);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `${BASE_SELECT} ${whereSql} ORDER BY c.status = 'for_approval' DESC, c.issued_date DESC, c.id DESC LIMIT 500`, params);
    res.json(rows.map(parseRow));
  } catch (err) { next(err); }
});

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try { res.json({ criteria: RATING_CRITERIA, approvers: await generalManagers() }); } catch (err) { next(err); }
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
    // The approving GM's e-signature (their profile signature), only once approved -- an unapproved
    // certificate must not carry anyone's signature.
    let signature = null;
    if (row.status === 'approved' && row.approver_user_id) {
      const [[u]] = await pool.query('SELECT signature_data FROM users WHERE id = ?', [row.approver_user_id]);
      signature = u?.signature_data || null;
    }
    res.json({ ...parseRow(row), signature });
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const { error, values } = readBody(req.body || {});
  if (error) return res.status(400).json({ error });
  const approverError = await checkApprover(values);
  if (approverError) return res.status(400).json({ error: approverError });
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
    askApproval(row, req.user.id);
    res.status(201).json(parseRow(row));
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { error, values } = readBody(req.body || {});
    if (error) return res.status(400).json({ error });
    const approverError = await checkApprover(values);
    if (approverError) return res.status(400).json({ error: approverError });
    // A changed certificate is a different document: it goes back to the approver, unsigned.
    const cols = Object.keys(values);
    const [r] = await pool.query(
      `UPDATE hr_coes SET ${cols.map((c) => `${c} = ?`).join(', ')}, status = 'for_approval',
              approved_at = NULL, rejected_reason = NULL, decided_at = NULL WHERE id = ?`,
      [...cols.map((c) => values[c]), req.params.id],
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Certificate not found' });
    const [[row]] = await pool.query(`${BASE_SELECT} WHERE c.id = ?`, [req.params.id]);
    askApproval(row, req.user.id);
    res.json(parseRow(row));
  } catch (err) { next(err); }
});

// Approve / reject: only the General Manager the certificate was sent to. Approving confirms the name
// printed above "General Manager" -- it starts as the name they signed with last time.
async function loadForDecision(req, res) {
  const [[row]] = await pool.query('SELECT * FROM hr_coes WHERE id = ?', [req.params.id]);
  if (!row) { res.status(404).json({ error: 'Certificate not found' }); return null; }
  // A System Admin can decide too (asked 2026-10-22) -- on the GM's behalf: the certificate is still
  // signed in the chosen General Manager's name.
  if (Number(row.approver_user_id) !== Number(req.user.id) && !(await isSystemAdmin(req.user.id))) {
    res.status(403).json({ error: 'Only the General Manager this certificate was sent to, or a System Admin, can approve it.' });
    return null;
  }
  if (row.status !== 'for_approval') { res.status(409).json({ error: `This certificate is already ${row.status}.` }); return null; }
  return row;
}

router.put('/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const row = await loadForDecision(req, res);
    if (!row) return;
    const gm = (await generalManagers()).find((g) => g.id === Number(row.approver_user_id));
    const name = trunc(req.body?.signatory_name, 150) || gm?.sign_as;
    if (!name) return res.status(400).json({ error: 'Enter your name as it is printed on the certificate.' });
    await pool.query(
      `UPDATE hr_coes SET status = 'approved', signatory_name = ?, signatory_title = ?, approved_at = NOW(),
              decided_at = NOW(), rejected_reason = NULL WHERE id = ?`,
      [name.toUpperCase(), trunc(req.body?.signatory_title, 150) || 'General Manager', row.id],
    );
    notify([row.created_by_user_id], {
      type: 'coe_approved', title: `${row.coe_no} was approved`,
      message: `Certificate of Employment for ${row.employee_name} is approved and ready to print.`,
    }, row.id, req.user.id);
    const [[out]] = await pool.query(`${BASE_SELECT} WHERE c.id = ?`, [row.id]);
    res.json(parseRow(out));
  } catch (err) { next(err); }
});

router.put('/:id/reject', requireAuth, async (req, res, next) => {
  try {
    const reason = trunc(req.body?.reason, 500);
    if (!reason) return res.status(400).json({ error: 'Say why it is rejected.' });
    const row = await loadForDecision(req, res);
    if (!row) return;
    await pool.query("UPDATE hr_coes SET status = 'rejected', rejected_reason = ?, decided_at = NOW() WHERE id = ?", [reason, row.id]);
    notify([row.created_by_user_id], {
      type: 'coe_rejected', title: `${row.coe_no} was rejected`,
      message: `Certificate of Employment for ${row.employee_name}: ${reason}`,
    }, row.id, req.user.id);
    const [[out]] = await pool.query(`${BASE_SELECT} WHERE c.id = ?`, [row.id]);
    res.json(parseRow(out));
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
