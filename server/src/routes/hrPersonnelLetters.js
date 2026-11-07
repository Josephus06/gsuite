const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, isSystemAdmin } = require('../middleware/auth');

// HRD > Regularization and HRD > Salary Adjustment (2026-11-07). HR's letters to one employee on the
// company's own templates; the setup and the reasons are in db/add-hr-personnel-letters.js.
//
// One table (hr_personnel_letters, `kind`), one router per letter -- built by makeRouter(kind) and
// mounted at /api/hr-regularization and /api/hr-salary-adjustment -- so each is its own page in User
// Permissions and a right on one never opens the other.
//
// Approval as on the COE and the Memo: HR picks the General Manager; it prints with a NOT YET APPROVED
// watermark and no GM name until that GM (or a System Admin on their behalf) approves, confirming the
// name printed above "General Manager". Editing sends it back for approval.
const KINDS = {
  regularization: { route: '/hrd/regularization', prefix: 'REG', label: 'Regularization' },
  salary_adjustment: { route: '/hrd/salary-adjustment', prefix: 'SAL', label: 'Salary Adjustment' },
};
const BASES = ['monthly', 'daily'];

const trunc = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const amount = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
};

function nameOf(r) {
  const mi = r.middle_initial ? `${String(r.middle_initial).replace(/\.$/, '')}.` : '';
  return ([r.first_name, mi, r.last_name].filter(Boolean).join(' ') || r.display_name || '').toUpperCase();
}

// The General Managers, each with the name a letter would carry: the one they confirmed on their last
// approved letter, else their employee record, else their display name.
async function generalManagers() {
  const [rows] = await pool.query(
    `SELECT u.id, u.display_name, e.first_name, e.middle_initial, e.last_name,
            (SELECT l.signatory_name FROM hr_personnel_letters l WHERE l.approver_user_id = u.id AND l.status = 'approved'
              ORDER BY l.approved_at DESC LIMIT 1) AS last_signed_as
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.is_active = 1
        AND (u.id IN (SELECT user_id FROM general_managers) OR u.account_type = 'General Manager')
      ORDER BY u.id`);
  return rows.map((r) => ({ id: Number(r.id), display_name: r.display_name, sign_as: (r.last_signed_as || nameOf(r)).toUpperCase() }));
}

const BASE_SELECT = `
  SELECT l.*, u.display_name AS created_by_name, e.employee_code, a.display_name AS approver_name
    FROM hr_personnel_letters l
    LEFT JOIN users u ON u.id = l.created_by_user_id
    LEFT JOIN users a ON a.id = l.approver_user_id
    LEFT JOIN employees e ON e.id = l.employee_id`;

function makeRouter(kind) {
  const K = KINDS[kind];
  const ROUTE = K.route;
  const router = express.Router();

  function readBody(body) {
    const employeeName = trunc(body.employee_name, 200);
    if (!employeeName) return { error: 'Choose the employee.' };
    if (!isDate(body.letter_date)) return { error: 'Enter the date of the letter.' };
    if (!isDate(body.effective_date)) return { error: `Enter the date the ${kind === 'regularization' ? 'regularization' : 'new rate'} takes effect.` };
    const values = {
      employee_id: body.employee_id ? Number(body.employee_id) || null : null,
      employee_name: employeeName,
      letter_date: body.letter_date,
      effective_date: body.effective_date,
      prepared_by_name: trunc(body.prepared_by_name, 150),
      prepared_by_title: trunc(body.prepared_by_title, 150),
      approver_user_id: Number(body.approver_user_id) || null,
      remarks: trunc(body.remarks, 500),
    };
    if (kind === 'regularization') {
      values.employee_address = trunc(body.employee_address, 300);
      values.salutation = trunc(body.salutation, 120);
    } else {
      const current = amount(body.current_rate);
      const next = amount(body.new_rate);
      if (Number.isNaN(current)) return { error: 'The current rate is not an amount.' };
      if (next == null || Number.isNaN(next) || next <= 0) return { error: 'Enter the new salary rate.' };
      values.current_rate = current;
      values.current_basis = BASES.includes(body.current_basis) ? body.current_basis : 'monthly';
      values.new_rate = next;
      values.new_basis = BASES.includes(body.new_basis) ? body.new_basis : values.current_basis;
    }
    return { values };
  }

  async function checkApprover(values) {
    const gms = await generalManagers();
    if (!gms.length) return 'There is no General Manager to approve it. Assign one first.';
    if (!values.approver_user_id) values.approver_user_id = gms[0].id;
    if (!gms.some((g) => g.id === values.approver_user_id)) return 'The approver must be a General Manager.';
    return null;
  }

  async function nextNumber(conn) {
    const [[row]] = await conn.query(
      `SELECT MAX(CAST(SUBSTRING(letter_no, ${K.prefix.length + 2}) AS UNSIGNED)) AS n
         FROM hr_personnel_letters WHERE letter_no LIKE ? FOR UPDATE`, [`${K.prefix}-%`]);
    return `${K.prefix}-${String((Number(row.n) || 0) + 1).padStart(4, '0')}`;
  }

  // After the change has committed; a failed notification is logged, never fatal.
  async function notify(userIds, { type, title, message }, letterId, actorId) {
    const ids = [...new Set(userIds.map(Number).filter((id) => id && id !== Number(actorId)))];
    for (const userId of ids) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, type, String(title).slice(0, 255), String(message).slice(0, 500), kind === 'regularization' ? 'HrRegularization' : 'HrSalaryAdjustment', letterId],
      ).catch((err) => console.error(`[notifications] ${K.label}:`, err.message));
    }
  }
  const askApproval = (row, actorId) => notify([row.approver_user_id], {
    type: `${kind}_for_approval`, title: `${row.letter_no} needs your approval`,
    message: `${K.label} letter for ${row.employee_name} is waiting for your approval.`,
  }, row.id, actorId);

  const one = async (id) => (await pool.query(`${BASE_SELECT} WHERE l.id = ? AND l.kind = ?`, [id, kind]))[0][0];

  router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
    try {
      const where = ['l.kind = ?'];
      const params = [kind];
      if (['for_approval', 'approved', 'rejected'].includes(req.query.status)) { where.push('l.status = ?'); params.push(req.query.status); }
      if (req.query.search) {
        where.push('(l.letter_no LIKE ? OR l.employee_name LIKE ? OR e.employee_code LIKE ?)');
        const q = `%${req.query.search}%`;
        params.push(q, q, q);
      }
      const [rows] = await pool.query(
        `${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.status = 'for_approval' DESC, l.letter_date DESC, l.id DESC LIMIT 500`, params);
      res.json(rows);
    } catch (err) { next(err); }
  });

  router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
    try {
      const [[me]] = await pool.query(
        `SELECT u.display_name, e.first_name, e.middle_initial, e.last_name, e.position_title
           FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.id = ?`, [req.user.id]);
      res.json({
        approvers: await generalManagers(),
        preparer: me ? { name: nameOf(me), title: me.position_title || '' } : { name: '', title: '' },
      });
    } catch (err) { next(err); }
  });

  // Employee lookup: active employees first.
  router.get('/employees', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
    try {
      const q = String(req.query.search || '').trim();
      const params = [];
      const where = [];
      if (q) {
        where.push(`(CONCAT_WS(' ', e.first_name, e.last_name) LIKE ? OR e.employee_code LIKE ? OR d.name LIKE ? OR e.position_title LIKE ?)`);
        params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      }
      const [rows] = await pool.query(
        `SELECT e.id, e.employee_code, e.first_name, e.middle_initial, e.last_name,
                CONCAT_WS(' ', e.first_name, e.last_name) AS employee_name,
                e.position_title, e.address, e.sex, e.date_hired, e.date_regularized, e.employment_status, e.is_active,
                d.name AS department_name
           FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY e.is_active DESC, employee_name
          LIMIT 50`, params);
      res.json(rows);
    } catch (err) { next(err); }
  });

  router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
    try {
      const row = await one(req.params.id);
      if (!row) return res.status(404).json({ error: 'Letter not found' });
      res.json(row);
    } catch (err) { next(err); }
  });

  router.get('/:id/print', requireAuth, requirePermission(ROUTE, 'can_print'), async (req, res, next) => {
    try {
      const row = await one(req.params.id);
      if (!row) return res.status(404).json({ error: 'Letter not found' });
      // E-signatures only once approved: the approving GM's and the preparer's (whoever wrote it).
      let signature = null;
      let preparerSignature = null;
      if (row.status === 'approved') {
        const ids = [row.approver_user_id, row.created_by_user_id].filter(Boolean);
        const [sigs] = ids.length ? await pool.query('SELECT id, signature_data FROM users WHERE id IN (?)', [ids]) : [[]];
        const sigOf = (id) => sigs.find((s) => Number(s.id) === Number(id))?.signature_data || null;
        signature = sigOf(row.approver_user_id);
        preparerSignature = sigOf(row.created_by_user_id);
      }
      res.json({ ...row, signature, preparer_signature: preparerSignature });
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
      const no = await nextNumber(conn);
      const cols = Object.keys(values);
      const [r] = await conn.query(
        `INSERT INTO hr_personnel_letters (letter_no, kind, ${cols.join(', ')}, created_by_user_id)
         VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?)`,
        [no, kind, ...cols.map((c) => values[c]), req.user.id]);
      await conn.commit();
      const row = await one(r.insertId);
      askApproval(row, req.user.id);
      res.status(201).json(row);
    } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
  });

  router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
    try {
      const { error, values } = readBody(req.body || {});
      if (error) return res.status(400).json({ error });
      const approverError = await checkApprover(values);
      if (approverError) return res.status(400).json({ error: approverError });
      // A changed letter is a different document: it goes back to the approver, unsigned.
      const cols = Object.keys(values);
      const [r] = await pool.query(
        `UPDATE hr_personnel_letters SET ${cols.map((c) => `${c} = ?`).join(', ')}, status = 'for_approval',
                approved_at = NULL, rejected_reason = NULL, decided_at = NULL WHERE id = ? AND kind = ?`,
        [...cols.map((c) => values[c]), req.params.id, kind]);
      if (!r.affectedRows) return res.status(404).json({ error: 'Letter not found' });
      const row = await one(req.params.id);
      askApproval(row, req.user.id);
      res.json(row);
    } catch (err) { next(err); }
  });

  // Approve / reject: the General Manager it was sent to, or a System Admin on their behalf.
  async function loadForDecision(req, res) {
    const [[row]] = await pool.query('SELECT * FROM hr_personnel_letters WHERE id = ? AND kind = ?', [req.params.id, kind]);
    if (!row) { res.status(404).json({ error: 'Letter not found' }); return null; }
    if (Number(row.approver_user_id) !== Number(req.user.id) && !(await isSystemAdmin(req.user.id))) {
      res.status(403).json({ error: 'Only the General Manager this letter was sent to, or a System Admin, can approve it.' });
      return null;
    }
    if (row.status !== 'for_approval') { res.status(409).json({ error: `This letter is already ${row.status}.` }); return null; }
    return row;
  }

  router.put('/:id/approve', requireAuth, async (req, res, next) => {
    try {
      const row = await loadForDecision(req, res);
      if (!row) return;
      const gm = (await generalManagers()).find((g) => g.id === Number(row.approver_user_id));
      const name = trunc(req.body?.signatory_name, 150) || gm?.sign_as;
      if (!name) return res.status(400).json({ error: 'Enter your name as it is printed on the letter.' });
      await pool.query(
        `UPDATE hr_personnel_letters SET status = 'approved', signatory_name = ?, signatory_title = ?, approved_at = NOW(),
                decided_at = NOW(), rejected_reason = NULL WHERE id = ?`,
        [name.toUpperCase(), trunc(req.body?.signatory_title, 150) || 'General Manager', row.id]);
      notify([row.created_by_user_id], {
        type: `${kind}_approved`, title: `${row.letter_no} was approved`,
        message: `${K.label} letter for ${row.employee_name} is approved and ready to print.`,
      }, row.id, req.user.id);
      res.json(await one(row.id));
    } catch (err) { next(err); }
  });

  router.put('/:id/reject', requireAuth, async (req, res, next) => {
    try {
      const reason = trunc(req.body?.reason, 500);
      if (!reason) return res.status(400).json({ error: 'Say why it is rejected.' });
      const row = await loadForDecision(req, res);
      if (!row) return;
      await pool.query("UPDATE hr_personnel_letters SET status = 'rejected', rejected_reason = ?, decided_at = NOW() WHERE id = ?", [reason, row.id]);
      notify([row.created_by_user_id], {
        type: `${kind}_rejected`, title: `${row.letter_no} was rejected`,
        message: `${K.label} letter for ${row.employee_name}: ${reason}`,
      }, row.id, req.user.id);
      res.json(await one(row.id));
    } catch (err) { next(err); }
  });

  router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
    try {
      const [r] = await pool.query('DELETE FROM hr_personnel_letters WHERE id = ? AND kind = ?', [req.params.id, kind]);
      if (!r.affectedRows) return res.status(404).json({ error: 'Letter not found' });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { makeRouter, KINDS };
