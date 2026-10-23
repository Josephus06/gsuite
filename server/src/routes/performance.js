const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');
const { insertFor } = require('../lib/approvalNotifications');
const {
  STATUS_LABELS, phToday, nowUtc, quarterDates, scores, overallLabel, generateEvaluations, closeCycle,
} = require('../lib/performance');

const router = express.Router();

// Performance Evaluation (2026-10-23; lib/performance.js).
//
//   Forms > My Performance (/performance)  your own quarter (remarks, self rating, conforme); the
//     people you supervise (remarks, your rating); as a department head, the reviews waiting on you.
//   HRD > Performance Evaluation (/hrd/performance)  HR: templates per position, core values,
//     quarters, every evaluation. Edit = HR review; Approve = the GM's approval.
const MY = '/performance';
const HR = '/hrd/performance';
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const rating = (v) => (v === '' || v == null ? null : ([1, 2, 3, 4].includes(Number(v)) ? Number(v) : undefined));

async function loadEvaluation(id) {
  const [[e]] = await pool.query(
    `SELECT e.*, c.year, c.quarter, c.start_date, c.end_date, c.status AS cycle_status,
            u.display_name AS employee_name, ru.display_name AS rater_name, hu.display_name AS dept_head_name,
            d.name AS department, emp.employee_code
       FROM perf_evaluations e JOIN perf_cycles c ON c.id = e.cycle_id JOIN users u ON u.id = e.user_id
       LEFT JOIN users ru ON ru.id = e.rater_user_id LEFT JOIN users hu ON hu.id = e.dept_head_user_id
       LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN employees emp ON emp.id = e.employee_id
      WHERE e.id = ?`, [id]);
  return e || null;
}

// Who the reader is to this evaluation, and so what they may see and do.
async function roleOf(userId, e) {
  const me = Number(userId);
  const hr = await userCan(me, HR, 'can_edit');
  const gm = await userCan(me, HR, 'can_approve');
  const hrView = await userCan(me, HR, 'can_view');
  const role = {
    employee: Number(e.user_id) === me, rater: Number(e.rater_user_id) === me, head: Number(e.dept_head_user_id) === me, hr, gm,
  };
  role.canSee = role.employee || role.rater || role.head || hrView;
  role.canRemark = e.status === 'open' && (role.employee || role.rater);
  role.canSelfRate = e.status === 'self_rating' && role.employee;
  role.canRate = e.status === 'supervisor_rating' && role.rater;
  // The rater's remarks on the core values stay open to the rater the whole way, until approved.
  role.canRaterRemark = e.status !== 'approved' && role.rater;
  role.canConforme = e.status === 'discussion' && role.employee;
  role.canReview = (e.status === 'dept_head_review' && role.head) || (e.status === 'hr_review' && hr) || (e.status === 'gm_approval' && gm);
  return role;
}

async function seeOr404(req, res) {
  const e = await loadEvaluation(req.params.id);
  if (!e) { bad(res, 'Evaluation not found.', 404); return null; }
  const role = await roleOf(req.user.id, e);
  if (!role.canSee) { bad(res, 'Evaluation not found.', 404); return null; }
  return { e, role };
}

const notify = (userIds, e, title, message, actorId) => insertFor(userIds.filter(Boolean), {
  type: 'performance', title: `${title}: ${e.employee_name} (Q${e.quarter} ${e.year})`, message, relatedType: 'PerfEvaluation', relatedId: e.id,
}, actorId).catch(() => {});

// ---------------------------------------------------------------- My Performance

// Mine, the people I rate, and the reviews waiting on me as a department head.
router.get('/inbox', requireAuth, requirePermission(MY, 'can_view'), async (req, res, next) => {
  try {
    const sel = `SELECT e.id, e.status, e.position_title, e.self_overall, e.sup_overall, c.year, c.quarter, c.end_date,
                        u.display_name AS employee_name, ru.display_name AS rater_name,
                        (SELECT COUNT(*) FROM perf_remarks r WHERE r.evaluation_id = e.id) AS remarks
                   FROM perf_evaluations e JOIN perf_cycles c ON c.id = e.cycle_id JOIN users u ON u.id = e.user_id
                   LEFT JOIN users ru ON ru.id = e.rater_user_id`;
    const [mine] = await pool.query(`${sel} WHERE e.user_id = ? ORDER BY c.year DESC, c.quarter DESC`, [req.user.id]);
    const [team] = await pool.query(`${sel} WHERE e.rater_user_id = ? ORDER BY c.year DESC, c.quarter DESC, u.display_name`, [req.user.id]);
    const [head] = await pool.query(`${sel} WHERE e.dept_head_user_id = ? ORDER BY e.status = 'dept_head_review' DESC, c.year DESC, c.quarter DESC, u.display_name`, [req.user.id]);
    res.json({ mine, team, head, status_labels: STATUS_LABELS });
  } catch (err) { next(err); }
});

router.get('/evaluations/:id', requireAuth, async (req, res, next) => {
  try {
    const ctx = await seeOr404(req, res);
    if (!ctx) return undefined;
    const { e, role } = ctx;
    const [items] = await pool.query('SELECT * FROM perf_evaluation_items WHERE evaluation_id = ? ORDER BY sort_order, id', [e.id]);
    const [remarks] = await pool.query(
      `SELECT r.*, u.display_name AS author_name FROM perf_remarks r JOIN users u ON u.id = r.author_user_id
        WHERE r.evaluation_id = ? ORDER BY r.remark_date DESC, r.id DESC`, [e.id]);
    // The supervisor's rating stays with the supervisor until it is submitted.
    const hideSup = role.employee && !role.rater && ['open', 'self_rating', 'supervisor_rating'].includes(e.status);
    const self = scores(items, 'self', e.kra_weight, e.cv_weight);
    const sup = hideSup ? { kra: null, cv: null, overall: null } : scores(items, 'sup', e.kra_weight, e.cv_weight);
    return res.json({
      ...e, status_label: STATUS_LABELS[e.status], role,
      items: items.map((i) => ({ ...i, weight: Number(i.weight), superior_rating: hideSup ? null : i.superior_rating, rater_results: hideSup ? null : i.rater_results })),
      remarks,
      ...(hideSup ? { superior_comments: null, strengths: null, improvements: null, coaching: null, career_plans: null } : {}),
      self_scores: { ...self, label: overallLabel(self.overall) }, sup_scores: { ...sup, label: overallLabel(sup.overall) },
    });
  } catch (err) { return next(err); }
});

// A dated remark during the quarter -- by the employee or their supervisor, on a KRA / core value or
// in general. Both see each other's.
router.post('/evaluations/:id/remarks', requireAuth, async (req, res, next) => {
  try {
    const ctx = await seeOr404(req, res);
    if (!ctx) return undefined;
    const { e, role } = ctx;
    if (!role.canRemark) return bad(res, 'Remarks are logged while the quarter is open, by the employee or their supervisor.', 409);
    const body = String(req.body.body || '').trim().slice(0, 4000);
    if (!body) return bad(res, 'Write the remark.');
    const date = isDate(req.body.remark_date) ? req.body.remark_date : phToday();
    let itemId = Number(req.body.item_id) || null;
    if (itemId) {
      const [[it]] = await pool.query('SELECT id FROM perf_evaluation_items WHERE id = ? AND evaluation_id = ?', [itemId, e.id]);
      if (!it) itemId = null;
    }
    const authorRole = role.rater && !role.employee ? 'supervisor' : 'employee';
    const [r] = await pool.query(
      'INSERT INTO perf_remarks (evaluation_id, item_id, author_user_id, author_role, remark_date, body) VALUES (?, ?, ?, ?, ?, ?)',
      [e.id, itemId, req.user.id, authorRole, date, body]);
    if (authorRole === 'supervisor') notify([e.user_id], e, 'New remark from your supervisor', body.slice(0, 200), req.user.id);
    return res.json({ id: r.insertId });
  } catch (err) { return next(err); }
});

router.delete('/remarks/:rid', requireAuth, async (req, res, next) => {
  try {
    const [[r]] = await pool.query(
      'SELECT r.*, e.status FROM perf_remarks r JOIN perf_evaluations e ON e.id = r.evaluation_id WHERE r.id = ?', [req.params.rid]);
    if (!r || Number(r.author_user_id) !== Number(req.user.id)) return bad(res, 'Remark not found.', 404);
    if (r.status !== 'open') return bad(res, 'The quarter has closed; its remarks are final.', 409);
    await pool.query('DELETE FROM perf_remarks WHERE id = ?', [r.id]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// Saves ratings (and actual results) for `field`; returns the items or an error. A core value's
// Critical Incidents are two remarks: the employee writes actual_results, the rater rater_results.
async function saveItems(e, list, field) {
  const [items] = await pool.query('SELECT id, section FROM perf_evaluation_items WHERE evaluation_id = ?', [e.id]);
  const sections = new Map(items.map((i) => [Number(i.id), i.section]));
  const rater = field === 'superior_rating';
  const txt = (v) => String(v || '').slice(0, 8000) || null;
  for (const it of Array.isArray(list) ? list : []) {
    if (!sections.has(Number(it.id))) continue;
    const cv = sections.get(Number(it.id)) === 'cv';
    const v = rating(it[field]);
    if (v === undefined) return 'Ratings are 1 to 4.';
    const sets = [`${field} = ?`];
    const params = [v];
    if (it.actual_results !== undefined && !(rater && cv)) { sets.push('actual_results = ?'); params.push(txt(it.actual_results)); }
    if (it.rater_results !== undefined && rater && cv) { sets.push('rater_results = ?'); params.push(txt(it.rater_results)); }
    await pool.query(`UPDATE perf_evaluation_items SET ${sets.join(', ')} WHERE id = ?`, [...params, it.id]);
  }
  return null;
}

async function storeScores(e) {
  const [items] = await pool.query('SELECT * FROM perf_evaluation_items WHERE evaluation_id = ?', [e.id]);
  const s = scores(items, 'self', e.kra_weight, e.cv_weight);
  const p = scores(items, 'sup', e.kra_weight, e.cv_weight);
  await pool.query('UPDATE perf_evaluations SET self_kra = ?, self_cv = ?, self_overall = ?, sup_kra = ?, sup_cv = ?, sup_overall = ? WHERE id = ?',
    [s.kra, s.cv, s.overall, p.kra, p.cv, p.overall, e.id]);
  return { items, self: s, sup: p };
}

// The rater's remarks on the core values (the blue box) -- at any step until the evaluation is approved.
router.put('/evaluations/:id/rater-remarks', requireAuth, async (req, res, next) => {
  try {
    const ctx = await seeOr404(req, res);
    if (!ctx) return undefined;
    const { e, role } = ctx;
    if (!role.canRaterRemark) return bad(res, "Only the employee's supervisor writes the rater's remarks, until the evaluation is approved.", 409);
    for (const it of Array.isArray(req.body.items) ? req.body.items : []) {
      await pool.query("UPDATE perf_evaluation_items SET rater_results = ? WHERE id = ? AND evaluation_id = ? AND section = 'cv'",
        [String(it.rater_results || '').slice(0, 8000) || null, it.id, e.id]);
    }
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// The employee's self rating (save, or submit to the supervisor).
router.put('/evaluations/:id/self', requireAuth, async (req, res, next) => {
  try {
    const ctx = await seeOr404(req, res);
    if (!ctx) return undefined;
    const { e, role } = ctx;
    if (!role.canSelfRate) return bad(res, 'Self rating is open to the employee once the quarter closes.', 409);
    const err = await saveItems(e, req.body.items, 'self_rating');
    if (err) return bad(res, err);
    const { self } = await storeScores(e);
    if (req.body.submit) {
      if (self.overall == null) return bad(res, 'Rate every KRA and core value before submitting.');
      await pool.query("UPDATE perf_evaluations SET status = 'supervisor_rating', self_submitted_at = ? WHERE id = ?", [nowUtc(), e.id]);
      notify([e.rater_user_id], e, 'Self rating submitted -- your rating next', 'Rate them, add your comments and development plan, and set the discussion.', req.user.id);
    }
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// The supervisor's rating, comments and development plan (save, or submit to the discussion).
router.put('/evaluations/:id/rate', requireAuth, async (req, res, next) => {
  try {
    const ctx = await seeOr404(req, res);
    if (!ctx) return undefined;
    const { e, role } = ctx;
    if (!role.canRate) return bad(res, "Only the employee's supervisor rates, after the self rating.", 409);
    const err = await saveItems(e, req.body.items, 'superior_rating');
    if (err) return bad(res, err);
    const t = (v) => String(v || '').trim().slice(0, 8000) || null;
    await pool.query(
      `UPDATE perf_evaluations SET superior_comments = ?, strengths = ?, improvements = ?, coaching = ?, career_plans = ?, discussion_date = ? WHERE id = ?`,
      [t(req.body.superior_comments), t(req.body.strengths), t(req.body.improvements), t(req.body.coaching), t(req.body.career_plans),
        isDate(req.body.discussion_date) ? req.body.discussion_date : null, e.id]);
    const { sup } = await storeScores(e);
    if (req.body.submit) {
      if (sup.overall == null) return bad(res, 'Rate every KRA and core value before submitting.');
      if (!isDate(req.body.discussion_date)) return bad(res, 'Set the date of the performance discussion.');
      if (!t(req.body.superior_comments)) return bad(res, "Write your comments and recommendation.");
      await pool.query("UPDATE perf_evaluations SET status = 'discussion', rated_at = ?, returned_reason = NULL WHERE id = ?", [nowUtc(), e.id]);
      notify([e.user_id], e, 'Your evaluation is rated', `Discuss it with your supervisor (${req.body.discussion_date}), then sign your conforme.`, req.user.id);
    }
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// The employee signs conforme after the discussion; on to the department head (or HR).
router.post('/evaluations/:id/conforme', requireAuth, async (req, res, next) => {
  try {
    const ctx = await seeOr404(req, res);
    if (!ctx) return undefined;
    const { e, role } = ctx;
    if (!role.canConforme) return bad(res, 'Conforme is signed by the employee after the discussion.', 409);
    // The department head reviews unless there is none, or they are the supervisor who just rated it.
    const next = e.dept_head_user_id && Number(e.dept_head_user_id) !== Number(e.rater_user_id) ? 'dept_head_review' : 'hr_review';
    await pool.query('UPDATE perf_evaluations SET status = ?, employee_conforme_at = ? WHERE id = ?', [next, nowUtc(), e.id]);
    if (next === 'dept_head_review') notify([e.dept_head_user_id], e, 'Evaluation for your review', 'Review the rating and approve or return it.', req.user.id);
    else {
      const { usersWithPermission } = require('../lib/approvalNotifications');
      notify(await usersWithPermission(HR, 'can_edit'), e, 'Evaluation for HR review', 'Review and pass it to the GM, or return it.', req.user.id);
    }
    return res.json({ ok: true, status: next });
  } catch (err) { return next(err); }
});

// Department head / HR / GM: approve (on to the next step) or return to the supervisor.
router.post('/evaluations/:id/review', requireAuth, async (req, res, next) => {
  try {
    const ctx = await seeOr404(req, res);
    if (!ctx) return undefined;
    const { e, role } = ctx;
    if (!role.canReview) return bad(res, 'This evaluation is not waiting on your review.', 409);
    const remarks = String(req.body.remarks || '').trim().slice(0, 1000) || null;
    const { usersWithPermission } = require('../lib/approvalNotifications');
    const stage = { dept_head_review: 'dept_head', hr_review: 'hr', gm_approval: 'gm' }[e.status];
    if (req.body.action === 'return') {
      if (!remarks) return bad(res, 'Say why it is returned.');
      await pool.query(
        `UPDATE perf_evaluations SET status = 'supervisor_rating', returned_reason = ?, employee_conforme_at = NULL, ${stage}_remarks = ? WHERE id = ?`,
        [remarks, remarks, e.id]);
      notify([e.rater_user_id], e, 'Evaluation returned to you', remarks, req.user.id);
      return res.json({ ok: true, status: 'supervisor_rating' });
    }
    const next = { dept_head_review: 'hr_review', hr_review: 'gm_approval', gm_approval: 'approved' }[e.status];
    await pool.query(`UPDATE perf_evaluations SET status = ?, ${stage}_by_user_id = ?, ${stage}_at = ?, ${stage}_remarks = ? WHERE id = ?`,
      [next, req.user.id, nowUtc(), remarks, e.id]);
    if (next === 'hr_review') notify(await usersWithPermission(HR, 'can_edit'), e, 'Evaluation for HR review', 'Reviewed by the department head.', req.user.id);
    if (next === 'gm_approval') notify(await usersWithPermission(HR, 'can_approve'), e, 'Evaluation for GM approval', 'Reviewed by HR.', req.user.id);
    if (next === 'approved') notify([e.user_id, e.rater_user_id], e, 'Evaluation approved', `Final rating ${e.sup_overall ?? ''} (${overallLabel(e.sup_overall) || ''}).`, req.user.id);
    return res.json({ ok: true, status: next });
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------- HR

router.get('/admin/meta', requireAuth, requirePermission(HR, 'can_view'), async (req, res, next) => {
  try {
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name');
    const [users] = await pool.query(
      `SELECT u.id, u.display_name, e.id AS employee_id, e.position_title, d.name AS department
         FROM users u LEFT JOIN employees e ON e.id = u.employee_id LEFT JOIN departments d ON d.id = e.department_id
        WHERE u.is_active = 1 ORDER BY u.display_name`);
    res.json({ departments, users, status_labels: STATUS_LABELS });
  } catch (err) { next(err); }
});

// Templates: a position's KRAs.
router.get('/templates', requireAuth, requirePermission(HR, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT t.*, d.name AS department,
              (SELECT COUNT(*) FROM perf_template_kras k WHERE k.template_id = t.id) AS kras,
              (SELECT COALESCE(SUM(k.weight), 0) FROM perf_template_kras k WHERE k.template_id = t.id) AS total_weight,
              (SELECT COUNT(*) FROM employees e JOIN users u ON u.employee_id = e.id AND u.is_active = 1
                WHERE LOWER(TRIM(e.position_title)) = LOWER(TRIM(t.position_title))) AS employees
         FROM perf_templates t LEFT JOIN departments d ON d.id = t.department_id ORDER BY t.is_active DESC, t.position_title`);
    res.json(rows.map((r) => ({ ...r, total_weight: Number(r.total_weight) })));
  } catch (err) { next(err); }
});

router.get('/templates/:id', requireAuth, requirePermission(HR, 'can_view'), async (req, res, next) => {
  try {
    const [[t]] = await pool.query('SELECT * FROM perf_templates WHERE id = ?', [req.params.id]);
    if (!t) return bad(res, 'Template not found.', 404);
    const [kras] = await pool.query('SELECT * FROM perf_template_kras WHERE template_id = ? ORDER BY sort_order, id', [t.id]);
    const [people] = await pool.query(
      `SELECT u.id AS user_id, u.display_name, e.id AS employee_id, d.name AS department
         FROM employees e JOIN users u ON u.employee_id = e.id AND u.is_active = 1 LEFT JOIN departments d ON d.id = e.department_id
        WHERE LOWER(TRIM(e.position_title)) = LOWER(TRIM(?)) ORDER BY u.display_name`, [t.position_title]);
    return res.json({ ...t, kras: kras.map((k) => ({ ...k, weight: Number(k.weight) })), people });
  } catch (err) { return next(err); }
});

function cleanTemplate(b) {
  const position = String(b.position_title || '').trim().slice(0, 150);
  if (!position) return { error: 'Name the position.' };
  const kras = (Array.isArray(b.kras) ? b.kras : []).map((k) => ({
    kra: String(k.kra || '').trim().slice(0, 500), weight: Number(k.weight), kpi: String(k.kpi || '').trim().slice(0, 500) || null,
    timeframe: String(k.timeframe || '').trim().slice(0, 100) || null,
  })).filter((k) => k.kra);
  if (!kras.length) return { error: 'Add at least one Key Result Area.' };
  if (kras.some((k) => !(k.weight > 0))) return { error: 'Every KRA needs a weight above 0.' };
  const total = Math.round(kras.reduce((m, k) => m + k.weight, 0) * 100) / 100;
  if (total !== 100) return { error: `The KRA weights add up to ${total}%; they must make 100%.` };
  return { position, kras, department_id: Number(b.department_id) || null, is_active: b.is_active === false ? 0 : 1 };
}

async function writeTemplate(id, c, userId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let tid = id;
    if (tid) await conn.query('UPDATE perf_templates SET position_title = ?, department_id = ?, is_active = ? WHERE id = ?', [c.position, c.department_id, c.is_active, tid]);
    else {
      const [r] = await conn.query('INSERT INTO perf_templates (position_title, department_id, created_by_user_id) VALUES (?, ?, ?)', [c.position, c.department_id, userId]);
      tid = r.insertId;
    }
    await conn.query('DELETE FROM perf_template_kras WHERE template_id = ?', [tid]);
    for (let i = 0; i < c.kras.length; i += 1) {
      const k = c.kras[i];
      await conn.query('INSERT INTO perf_template_kras (template_id, sort_order, kra, weight, kpi, timeframe) VALUES (?, ?, ?, ?, ?, ?)', [tid, i, k.kra, k.weight, k.kpi, k.timeframe]);
    }
    await conn.commit();
    return tid;
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
}

router.post('/templates', requireAuth, requirePermission(HR, 'can_add'), async (req, res, next) => {
  try {
    const c = cleanTemplate(req.body);
    if (c.error) return bad(res, c.error);
    const [[dup]] = await pool.query('SELECT id FROM perf_templates WHERE LOWER(TRIM(position_title)) = LOWER(?)', [c.position]);
    if (dup) return bad(res, 'That position already has a template.');
    return res.json({ id: await writeTemplate(null, c, req.user.id) });
  } catch (err) { return next(err); }
});

router.put('/templates/:id', requireAuth, requirePermission(HR, 'can_edit'), async (req, res, next) => {
  try {
    const c = cleanTemplate(req.body);
    if (c.error) return bad(res, c.error);
    const [[dup]] = await pool.query('SELECT id FROM perf_templates WHERE LOWER(TRIM(position_title)) = LOWER(?) AND id <> ?', [c.position, req.params.id]);
    if (dup) return bad(res, 'Another template already has that position.');
    await writeTemplate(Number(req.params.id), c, req.user.id);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// Puts employees in the template's position (their employee record's Position Title).
router.post('/templates/:id/assign', requireAuth, requirePermission(HR, 'can_edit'), async (req, res, next) => {
  try {
    const [[t]] = await pool.query('SELECT * FROM perf_templates WHERE id = ?', [req.params.id]);
    if (!t) return bad(res, 'Template not found.', 404);
    const add = (req.body.employee_ids || []).map(Number).filter(Boolean);
    const remove = (req.body.remove_employee_ids || []).map(Number).filter(Boolean);
    if (add.length) await pool.query('UPDATE employees SET position_title = ? WHERE id IN (?)', [t.position_title, add]);
    if (remove.length) await pool.query('UPDATE employees SET position_title = NULL WHERE id IN (?) AND LOWER(TRIM(position_title)) = LOWER(TRIM(?))', [remove, t.position_title]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// Import a PEF workbook (2026-10-23): each sheet's position becomes (or updates) its template, and the
// employee named on the sheet is put in that position. Preview first (apply: false) -- what each sheet
// reads as, and who it matched -- then apply.
// Lower case, accents and punctuation off, middle initials dropped ("Jean Mika V. Pecolados" = "JEAN MIKA PECOLADOS").
const normName = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1).join(' ');
async function matchUser(name) {
  const n = normName(name);
  if (!n) return null;
  const [rows] = await pool.query(
    `SELECT u.id AS user_id, u.display_name, e.id AS employee_id, e.first_name, e.last_name
       FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.is_active = 1`);
  const initials = (r) => normName(`${r.first_name || ''} ${r.last_name || ''}`).split(' ').filter(Boolean).map((w) => w[0]).join('');
  return rows.find((r) => normName(r.display_name) === n || normName(`${r.first_name} ${r.last_name}`) === n)
    || rows.find((r) => n.length <= 4 && !n.includes(' ') && (initials(r) === n || normName(r.display_name).split(' ').map((w) => w[0]).join('') === n))
    || null;
}

router.post('/templates/import', requireAuth, requirePermission(HR, 'can_add'), async (req, res, next) => {
  try {
    const { readPef } = require('../lib/pefImport');
    const raw = String(req.body.file_data || '').replace(/^data:[^,]*,/, '');
    if (!raw) return bad(res, 'Attach the PEF workbook (.xlsx).');
    let sheets;
    try { sheets = await readPef(Buffer.from(raw, 'base64')); } catch { return bad(res, 'That file could not be read as an Excel workbook (.xlsx).'); }
    if (!sheets.length) return bad(res, 'No evaluation form was found in that workbook.');
    const out = [];
    for (const s of sheets) {
      const employee = await matchUser(s.employee_name);
      const rater = await matchUser(s.rater_name);
      const [[existing]] = await pool.query('SELECT id FROM perf_templates WHERE LOWER(TRIM(position_title)) = LOWER(TRIM(?))', [s.position_title]);
      const problem = !s.position_title ? 'No POSITION TITLE on the sheet.' : !s.kras.length ? 'No Key Result Areas found.' : s.total !== 100 ? `KRA weights add up to ${s.total}%, not 100%.` : null;
      out.push({ ...s, template_exists: !!existing, employee: employee ? { user_id: employee.user_id, employee_id: employee.employee_id, name: employee.display_name } : null,
        rater: rater ? { user_id: rater.user_id, name: rater.display_name } : null, problem });
    }
    // One position on several sheets (an original and its REV): the LAST valid sheet sets the
    // template; the earlier ones still put their employee in the position.
    for (let i = 0; i < out.length; i += 1) {
      const later = out.slice(i + 1).find((x) => !x.problem && x.position_title.toLowerCase() === out[i].position_title.toLowerCase());
      if (later && !out[i].problem) out[i].superseded_by = later.sheet;
    }
    if (!req.body.apply) return res.json({ sheets: out });
    const pick = Array.isArray(req.body.sheets) ? new Set(req.body.sheets) : null;
    const done = [];
    for (const s of out) {
      if (pick && !pick.has(s.sheet)) continue;
      // A sheet with a problem, or one a later sheet supersedes, does not set the template -- but
      // its employee is still put in the position when that position gets a template.
      if (s.problem || s.superseded_by) {
        if (s.employee?.employee_id && s.position_title && out.some((x) => !x.problem && !x.superseded_by && x.position_title.toLowerCase() === s.position_title.toLowerCase())) {
          await pool.query('UPDATE employees SET position_title = ? WHERE id = ?', [s.position_title, s.employee.employee_id]);
          done.push({ sheet: s.sheet, position_title: s.position_title, template_from: out.find((x) => !x.problem && !x.superseded_by && x.position_title.toLowerCase() === s.position_title.toLowerCase()).sheet, assigned: s.employee.name });
        }
        continue;
      }
      const [[existing]] = await pool.query('SELECT id FROM perf_templates WHERE LOWER(TRIM(position_title)) = LOWER(TRIM(?))', [s.position_title]);
      const tid = await writeTemplate(existing?.id || null, { position: s.position_title, kras: s.kras, department_id: null, is_active: 1 }, req.user.id);
      if (s.employee?.employee_id) await pool.query('UPDATE employees SET position_title = ? WHERE id = ?', [s.position_title, s.employee.employee_id]);
      done.push({ sheet: s.sheet, template_id: tid, position_title: s.position_title, updated: !!existing, assigned: s.employee?.name || null });
    }
    return res.json({ applied: done });
  } catch (err) { return next(err); }
});

// Core values (company-wide).
router.get('/core-values', requireAuth, requirePermission(HR, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM perf_core_values WHERE is_active = 1 ORDER BY sort_order, id');
    res.json(rows.map((r) => ({ ...r, weight: Number(r.weight) })));
  } catch (err) { next(err); }
});

router.put('/core-values', requireAuth, requirePermission(HR, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const list = (Array.isArray(req.body.values) ? req.body.values : []).map((v) => ({
      id: Number(v.id) || null, name: String(v.name || '').trim().slice(0, 100), description: String(v.description || '').trim() || null, weight: Number(v.weight),
    })).filter((v) => v.name);
    if (!list.length) return bad(res, 'Keep at least one core value.');
    const total = Math.round(list.reduce((m, v) => m + v.weight, 0) * 100) / 100;
    if (total !== 100) return bad(res, `The core value weights add up to ${total}%; they must make 100%.`);
    await conn.beginTransaction();
    const keep = [];
    for (let i = 0; i < list.length; i += 1) {
      const v = list[i];
      if (v.id) { await conn.query('UPDATE perf_core_values SET name = ?, description = ?, weight = ?, sort_order = ?, is_active = 1 WHERE id = ?', [v.name, v.description, v.weight, i, v.id]); keep.push(v.id); }
      else { const [r] = await conn.query('INSERT INTO perf_core_values (name, description, weight, sort_order) VALUES (?, ?, ?, ?)', [v.name, v.description, v.weight, i]); keep.push(r.insertId); }
    }
    await conn.query('UPDATE perf_core_values SET is_active = 0 WHERE id NOT IN (?)', [keep]);
    await conn.commit();
    return res.json({ ok: true });
  } catch (err) { await conn.rollback().catch(() => {}); return next(err); } finally { conn.release(); }
});

// Quarters.
router.get('/cycles', requireAuth, requirePermission(HR, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, COUNT(e.id) AS evaluations, ${Object.keys(STATUS_LABELS).map((s) => `SUM(e.status = '${s}') AS n_${s}`).join(', ')}
         FROM perf_cycles c LEFT JOIN perf_evaluations e ON e.cycle_id = c.id GROUP BY c.id ORDER BY c.year DESC, c.quarter DESC`);
    res.json({ rows, status_labels: STATUS_LABELS });
  } catch (err) { next(err); }
});

router.post('/cycles', requireAuth, requirePermission(HR, 'can_add'), async (req, res, next) => {
  try {
    const year = Number(req.body.year);
    const quarter = Number(req.body.quarter);
    if (!(year >= 2024 && year <= 2100) || ![1, 2, 3, 4].includes(quarter)) return bad(res, 'Pick the year and quarter.');
    const [[dup]] = await pool.query('SELECT id FROM perf_cycles WHERE year = ? AND quarter = ?', [year, quarter]);
    if (dup) return bad(res, `Q${quarter} ${year} is already open.`);
    const { start, end } = quarterDates(year, quarter);
    const [r] = await pool.query('INSERT INTO perf_cycles (year, quarter, start_date, end_date, created_by_user_id) VALUES (?, ?, ?, ?, ?)', [year, quarter, start, end, req.user.id]);
    const out = await generateEvaluations(r.insertId);
    // Everyone given an evaluation is told the quarter's remarks are open.
    if (out.created.length) {
      const [rows] = await pool.query('SELECT id, user_id FROM perf_evaluations WHERE id IN (?)', [out.created]);
      for (const e of rows) {
        await insertFor([e.user_id], {
          type: 'performance', title: `Q${quarter} ${year} performance evaluation is open`,
          message: 'Log your accomplishments during the quarter (Forms > My Performance); your supervisor adds remarks too.',
          relatedType: 'PerfEvaluation', relatedId: e.id,
        }, req.user.id).catch(() => {});
      }
    }
    return res.json({ id: r.insertId, created: out.created.length, skipped: out.skipped });
  } catch (err) { return next(err); }
});

// Re-run: people given a template since get theirs.
router.post('/cycles/:id/generate', requireAuth, requirePermission(HR, 'can_add'), async (req, res, next) => {
  try {
    const out = await generateEvaluations(Number(req.params.id));
    res.json({ created: out.created.length, skipped: out.skipped });
  } catch (err) { next(err); }
});

router.post('/cycles/:id/close', requireAuth, requirePermission(HR, 'can_edit'), async (req, res, next) => {
  try { res.json(await closeCycle(Number(req.params.id), req.user.id)); } catch (err) { next(err); }
});

router.get('/cycles/:id/evaluations', requireAuth, requirePermission(HR, 'can_view'), async (req, res, next) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM perf_cycles WHERE id = ?', [req.params.id]);
    if (!c) return bad(res, 'Not found.', 404);
    const [rows] = await pool.query(
      `SELECT e.id, e.status, e.position_title, e.self_overall, e.sup_overall, u.display_name AS employee_name, d.name AS department,
              ru.display_name AS rater_name, hu.display_name AS dept_head_name,
              (SELECT COUNT(*) FROM perf_remarks r WHERE r.evaluation_id = e.id AND r.author_role = 'employee') AS employee_remarks,
              (SELECT COUNT(*) FROM perf_remarks r WHERE r.evaluation_id = e.id AND r.author_role = 'supervisor') AS supervisor_remarks
         FROM perf_evaluations e JOIN users u ON u.id = e.user_id LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN users ru ON ru.id = e.rater_user_id LEFT JOIN users hu ON hu.id = e.dept_head_user_id
        WHERE e.cycle_id = ? ORDER BY d.name, u.display_name`, [c.id]);
    return res.json({ cycle: c, rows: rows.map((r) => ({ ...r, label: overallLabel(r.sup_overall), status_label: STATUS_LABELS[r.status] })) });
  } catch (err) { return next(err); }
});

// HR changes who rates / reviews one evaluation.
router.put('/evaluations/:id/people', requireAuth, requirePermission(HR, 'can_edit'), async (req, res, next) => {
  try {
    const e = await loadEvaluation(req.params.id);
    if (!e) return bad(res, 'Not found.', 404);
    if (e.status === 'approved') return bad(res, 'An approved evaluation is final.', 409);
    await pool.query('UPDATE perf_evaluations SET rater_user_id = ?, dept_head_user_id = ? WHERE id = ?',
      [Number(req.body.rater_user_id) || null, Number(req.body.dept_head_user_id) || null, e.id]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

module.exports = router;
