const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, isSystemAdmin } = require('../middleware/auth');

const router = express.Router();

// HRD > Memo (2026-10-27). HR's memos to employees, printed on the company's memo template
// ("NOVEMBER 2026.docx"): TO / FROM / DATE / SUBJECT, a heading ("ANNOUNCEMENT:"), the body, then
// "Prepared by" (HR) and "Approved by" (the General Manager).
//
// The body is a list of blocks, printed in order:
//   { type: 'text',  text, bold }            a paragraph (blank lines inside it are kept)
//   { type: 'table', columns: [..], rows: [[..]] }   a table such as the holiday list
//
// Approval works as on the COE: HR picks which General Manager approves -- there can be two -- the
// memo is signed in the name of the GM who approved it and carries their e-signature. Until then it
// prints with a NOT YET APPROVED watermark. Editing a memo sends it back for approval.
const ROUTE = '/hrd/memo';
const STATUSES = ['for_approval', 'approved', 'rejected'];
const MAX_BLOCKS = 60;
const MAX_COLS = 8;
const MAX_ROWS = 80;

const trunc = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const cell = (v) => String(v ?? '').slice(0, 300);

// Only the two block shapes, trimmed to size, empty paragraphs and tables without a column dropped
// -- the printed memo is built from exactly this.
function cleanBody(input) {
  const out = [];
  for (const b of (Array.isArray(input) ? input : []).slice(0, MAX_BLOCKS)) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'table') {
      const columns = (Array.isArray(b.columns) ? b.columns : []).slice(0, MAX_COLS).map(cell);
      if (!columns.length) continue;
      const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, MAX_ROWS)
        .map((r) => columns.map((_, i) => cell(Array.isArray(r) ? r[i] : '')))
        .filter((r) => r.some((c) => c.trim()));
      out.push({ type: 'table', columns, rows });
    } else {
      const text = String(b.text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '').slice(0, 5000);
      if (!text.trim()) continue;
      out.push({ type: 'text', text, bold: !!b.bold });
    }
  }
  return out;
}

function parseRow(r) {
  if (!r) return r;
  let body = r.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  return { ...r, body: Array.isArray(body) ? body : [] };
}

async function nextNumber(conn) {
  const [[row]] = await conn.query(
    "SELECT MAX(CAST(SUBSTRING(memo_no, 6) AS UNSIGNED)) AS n FROM hr_memos WHERE memo_no LIKE 'MEMO-%' FOR UPDATE",
  );
  return `MEMO-${String((Number(row.n) || 0) + 1).padStart(4, '0')}`;
}

function readBody(body) {
  const subject = trunc(body.subject, 250);
  if (!subject) return { error: 'Enter the subject.' };
  if (!isDate(body.memo_date)) return { error: 'Enter the memo date.' };
  const blocks = cleanBody(body.body);
  if (!blocks.length) return { error: 'Write the memo: add at least one paragraph or table.' };
  return {
    values: {
      memo_to: trunc(body.memo_to, 200) || 'ALL EMPLOYEES',
      memo_from: trunc(body.memo_from, 200) || 'HR DEPARTMENT',
      memo_date: body.memo_date,
      subject,
      heading: trunc(body.heading, 150),
      body: JSON.stringify(blocks),
      prepared_by_name: trunc(body.prepared_by_name, 150),
      prepared_by_title: trunc(body.prepared_by_title, 150),
      approver_user_id: Number(body.approver_user_id) || null,
      remarks: trunc(body.remarks, 500),
    },
  };
}

const BASE_SELECT = `
  SELECT m.*, u.display_name AS created_by_name, a.display_name AS approver_name
    FROM hr_memos m
    LEFT JOIN users u ON u.id = m.created_by_user_id
    LEFT JOIN users a ON a.id = m.approver_user_id`;

// "ELA MAY A. ESTILLORE": the name on a user's employee record, else their display name.
function nameOf(r) {
  const mi = r.middle_initial ? `${String(r.middle_initial).replace(/\.$/, '')}.` : '';
  return ([r.first_name, mi, r.last_name].filter(Boolean).join(' ') || r.display_name || '').toUpperCase();
}

// The General Managers (as on the COE), each with the name a memo would carry: the one they confirmed
// on their last approved memo, else on their last certificate, else their employee record.
async function generalManagers() {
  const [rows] = await pool.query(
    `SELECT u.id, u.display_name, e.first_name, e.middle_initial, e.last_name,
            (SELECT m.signatory_name FROM hr_memos m WHERE m.approver_user_id = u.id AND m.status = 'approved'
              ORDER BY m.approved_at DESC LIMIT 1) AS memo_signed_as,
            (SELECT c.signatory_name FROM hr_coes c WHERE c.approver_user_id = u.id AND c.status = 'approved'
              ORDER BY c.approved_at DESC LIMIT 1) AS coe_signed_as
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.is_active = 1
        AND (u.id IN (SELECT user_id FROM general_managers) OR u.account_type = 'General Manager')
      ORDER BY u.id`);
  return rows.map((r) => ({
    id: Number(r.id),
    display_name: r.display_name,
    sign_as: (r.memo_signed_as || r.coe_signed_as || nameOf(r)).toUpperCase(),
  }));
}

async function checkApprover(values) {
  const gms = await generalManagers();
  if (!gms.length) return 'There is no General Manager to approve it. Assign one first.';
  if (!values.approver_user_id) values.approver_user_id = gms[0].id;
  if (!gms.some((g) => g.id === values.approver_user_id)) return 'The approver must be a General Manager.';
  return null;
}

// After the change has committed; a failed notification is logged, never fatal.
async function notify(userIds, { type, title, message }, memoId, actorId) {
  const ids = [...new Set(userIds.map(Number).filter((id) => id && id !== Number(actorId)))];
  for (const userId of ids) {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
       VALUES (?, ?, ?, ?, 'HrMemo', ?)`,
      [userId, type, String(title).slice(0, 255), String(message).slice(0, 500), memoId],
    ).catch((err) => console.error('[notifications] Memo:', err.message));
  }
}

const askApproval = (row, actorId) => notify([row.approver_user_id], {
  type: 'memo_for_approval',
  title: `${row.memo_no} needs your approval`,
  message: `Memo "${row.subject}" is waiting for your approval.`,
}, row.id, actorId);

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (STATUSES.includes(req.query.status)) { where.push('m.status = ?'); params.push(req.query.status); }
    if (req.query.search) {
      where.push('(m.memo_no LIKE ? OR m.subject LIKE ? OR m.memo_to LIKE ? OR m.memo_from LIKE ?)');
      const q = `%${req.query.search}%`;
      params.push(q, q, q, q);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `${BASE_SELECT} ${whereSql} ORDER BY m.status = 'for_approval' DESC, m.memo_date DESC, m.id DESC LIMIT 500`, params);
    res.json(rows.map(parseRow));
  } catch (err) { next(err); }
});

// The approvers, and who "Prepared by" starts as: the person writing the memo.
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

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(`${BASE_SELECT} WHERE m.id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Memo not found' });
    res.json(parseRow(row));
  } catch (err) { next(err); }
});

router.get('/:id/print', requireAuth, requirePermission(ROUTE, 'can_print'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(`${BASE_SELECT} WHERE m.id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Memo not found' });
    // E-signatures only once approved: the approving GM's, and the preparer's (whoever wrote it) --
    // an unapproved memo must not carry anyone's signature.
    let signature = null;
    let preparerSignature = null;
    if (row.status === 'approved') {
      const ids = [row.approver_user_id, row.created_by_user_id].filter(Boolean);
      const [sigs] = ids.length ? await pool.query('SELECT id, signature_data FROM users WHERE id IN (?)', [ids]) : [[]];
      const sigOf = (id) => sigs.find((s) => Number(s.id) === Number(id))?.signature_data || null;
      signature = sigOf(row.approver_user_id);
      preparerSignature = sigOf(row.created_by_user_id);
    }
    res.json({ ...parseRow(row), signature, preparer_signature: preparerSignature });
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
    const memoNo = await nextNumber(conn);
    const cols = Object.keys(values);
    const [r] = await conn.query(
      `INSERT INTO hr_memos (memo_no, ${cols.join(', ')}, created_by_user_id) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
      [memoNo, ...cols.map((c) => values[c]), req.user.id],
    );
    await conn.commit();
    const [[row]] = await pool.query(`${BASE_SELECT} WHERE m.id = ?`, [r.insertId]);
    askApproval(row, req.user.id);
    res.status(201).json(parseRow(row));
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { error, values } = readBody(req.body || {});
    if (error) return res.status(400).json({ error });
    const approverError = await checkApprover(values);
    if (approverError) return res.status(400).json({ error: approverError });
    // A changed memo is a different document: it goes back to the approver, unsigned.
    const cols = Object.keys(values);
    const [r] = await pool.query(
      `UPDATE hr_memos SET ${cols.map((c) => `${c} = ?`).join(', ')}, status = 'for_approval',
              approved_at = NULL, rejected_reason = NULL, decided_at = NULL WHERE id = ?`,
      [...cols.map((c) => values[c]), req.params.id],
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Memo not found' });
    const [[row]] = await pool.query(`${BASE_SELECT} WHERE m.id = ?`, [req.params.id]);
    askApproval(row, req.user.id);
    res.json(parseRow(row));
  } catch (err) { next(err); }
});

// Approve / reject: the General Manager the memo was sent to, or a System Admin on their behalf (the
// memo is still signed in the chosen GM's name).
async function loadForDecision(req, res) {
  const [[row]] = await pool.query('SELECT * FROM hr_memos WHERE id = ?', [req.params.id]);
  if (!row) { res.status(404).json({ error: 'Memo not found' }); return null; }
  if (Number(row.approver_user_id) !== Number(req.user.id) && !(await isSystemAdmin(req.user.id))) {
    res.status(403).json({ error: 'Only the General Manager this memo was sent to, or a System Admin, can approve it.' });
    return null;
  }
  if (row.status !== 'for_approval') { res.status(409).json({ error: `This memo is already ${row.status}.` }); return null; }
  return row;
}

router.put('/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const row = await loadForDecision(req, res);
    if (!row) return;
    const gm = (await generalManagers()).find((g) => g.id === Number(row.approver_user_id));
    const name = trunc(req.body?.signatory_name, 150) || gm?.sign_as;
    if (!name) return res.status(400).json({ error: 'Enter your name as it is printed on the memo.' });
    await pool.query(
      `UPDATE hr_memos SET status = 'approved', signatory_name = ?, signatory_title = ?, approved_at = NOW(),
              decided_at = NOW(), rejected_reason = NULL WHERE id = ?`,
      [name.toUpperCase(), trunc(req.body?.signatory_title, 150) || 'General Manager', row.id],
    );
    notify([row.created_by_user_id], {
      type: 'memo_approved', title: `${row.memo_no} was approved`,
      message: `Memo "${row.subject}" is approved and ready to print.`,
    }, row.id, req.user.id);
    const [[out]] = await pool.query(`${BASE_SELECT} WHERE m.id = ?`, [row.id]);
    res.json(parseRow(out));
  } catch (err) { next(err); }
});

router.put('/:id/reject', requireAuth, async (req, res, next) => {
  try {
    const reason = trunc(req.body?.reason, 500);
    if (!reason) return res.status(400).json({ error: 'Say why it is rejected.' });
    const row = await loadForDecision(req, res);
    if (!row) return;
    await pool.query("UPDATE hr_memos SET status = 'rejected', rejected_reason = ?, decided_at = NOW() WHERE id = ?", [reason, row.id]);
    notify([row.created_by_user_id], {
      type: 'memo_rejected', title: `${row.memo_no} was rejected`,
      message: `Memo "${row.subject}": ${reason}`,
    }, row.id, req.user.id);
    const [[out]] = await pool.query(`${BASE_SELECT} WHERE m.id = ?`, [row.id]);
    res.json(parseRow(out));
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [r] = await pool.query('DELETE FROM hr_memos WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Memo not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
